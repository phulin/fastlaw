import {
	type Entry,
	type FileEntry,
	Reader,
	Uint8ArrayReader,
	Writer,
	ZipReader,
} from "@zip.js/zip.js";
import { Parser } from "htmlparser2";

/**
 * USC XML fetcher
 *
 * Downloads USC XML files from the House OLRC website.
 * The current download page provides per-title XML links (usually zip archives).
 */

const USC_DOWNLOAD_PAGE_URL =
	"https://uscode.house.gov/download/download.shtml";

const XML_TITLE_LINK_RE = /xml_usc(?!all)(\d{2}[a-z]?)@/i;

/**
 * Get list of available USC title XML URLs by crawling the download page.
 */
export async function getUSCTitleUrls(): Promise<string[]> {
	const html = await fetchDownloadPageHtml();
	if (!html) {
		throw new Error("Failed to get USC download page.");
	}

	const hrefs = extractHrefLinks(html);
	const urls = hrefs
		.map((href) => new URL(href, USC_DOWNLOAD_PAGE_URL).toString())
		.filter((url) => XML_TITLE_LINK_RE.test(url));

	const byTitle = new Map<string, string>();
	for (const url of urls) {
		const titleNum = getTitleNumFromUrl(url);
		if (!titleNum) continue;
		if (!byTitle.has(titleNum)) {
			byTitle.set(titleNum, url);
		}
	}

	if (byTitle.size === 0) {
		throw new Error("Found no titles on USC download page.");
	}

	return [...byTitle.values()];
}

const USC_R2_PREFIX = "sources/usc/";

/**
 * Extract filename from URL for R2 storage key
 */
function getFilenameFromUrl(url: string): string {
	const urlObj = new URL(url);
	const pathname = urlObj.pathname;
	return pathname.split("/").pop() ?? "";
}

/**
 * Extract title number from USC URL
 */
export function getTitleNumFromUrl(url: string): string | null {
	const match =
		url.match(/xml_usc(\d{2}[a-z]?)@/i) || url.match(/usc(\d+[a-z]?)\.xml$/i);
	if (!match) return null;

	// Remove leading zeros
	const num = match[1].replace(/^0+/, "") || "0";
	return num;
}

async function fetchDownloadPageHtml(): Promise<string | null> {
	try {
		const response = await fetch(USC_DOWNLOAD_PAGE_URL, {
			headers: {
				"User-Agent": "fastlaw-ingest/1.0",
			},
		});

		if (!response.ok) {
			console.warn(`Failed to fetch USC download page: ${response.status}`);
			return null;
		}

		return await response.text();
	} catch (error) {
		console.error("Error fetching USC download page:", error);
		return null;
	}
}

function extractHrefLinks(html: string): string[] {
	const links: string[] = [];
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				if (name === "a" && attribs.href) {
					links.push(attribs.href);
				}
			},
		},
		{ decodeEntities: true },
	);

	parser.write(html);
	parser.end();

	return links;
}

function isFileEntry(entry: Entry): entry is FileEntry {
	return entry.directory === false;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB uncompressed chunks

/**
 * Custom zip.js Reader that uses R2 range requests.
 * Avoids loading the entire ZIP into memory.
 */
class R2RangeReader extends Reader<void> {
	private storage: R2Bucket;
	private key: string;
	declare size: number;

	constructor(storage: R2Bucket, key: string, size: number) {
		super();
		this.storage = storage;
		this.key = key;
		this.size = size;
	}

	override async init(): Promise<void> {
		await super.init?.();
		// Size is set in constructor
	}

	override async readUint8Array(
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		const obj = await this.storage.get(this.key, {
			range: { offset, length },
		});
		if (!obj) {
			throw new Error(`Failed to read range from R2: ${this.key}`);
		}
		return new Uint8Array(await obj.arrayBuffer());
	}
}

/**
 * Custom writer that yields chunks of a specified size
 */
class ChunkingWriter extends Writer<void> {
	private chunks: Uint8Array[] = [];
	private buffer: Uint8Array[] = [];
	private bufferSize = 0;

	override async init(): Promise<void> {
		await super.init?.();
		this.chunks = [];
		this.buffer = [];
		this.bufferSize = 0;
	}

	override async writeUint8Array(data: Uint8Array): Promise<void> {
		this.buffer.push(data);
		this.bufferSize += data.length;

		while (this.bufferSize >= CHUNK_SIZE) {
			this.flushChunk();
		}
	}

	private flushChunk(): void {
		// Concatenate buffer into one array
		const combined = new Uint8Array(this.bufferSize);
		let offset = 0;
		for (const chunk of this.buffer) {
			combined.set(chunk, offset);
			offset += chunk.length;
		}

		// Take CHUNK_SIZE bytes for the output chunk
		this.chunks.push(combined.slice(0, CHUNK_SIZE));

		// Keep remainder in buffer
		if (this.bufferSize > CHUNK_SIZE) {
			this.buffer = [combined.slice(CHUNK_SIZE)];
			this.bufferSize = this.bufferSize - CHUNK_SIZE;
		} else {
			this.buffer = [];
			this.bufferSize = 0;
		}
	}

	override async getData(): Promise<void> {
		// Flush any remaining data as final chunk
		if (this.bufferSize > 0) {
			const combined = new Uint8Array(this.bufferSize);
			let offset = 0;
			for (const chunk of this.buffer) {
				combined.set(chunk, offset);
				offset += chunk.length;
			}
			this.chunks.push(combined);
			this.buffer = [];
			this.bufferSize = 0;
		}
	}

	getChunks(): Uint8Array[] {
		return this.chunks;
	}
}

/**
 * Extract XML from a ZIP file as streaming chunks of Uint8Array.
 * Yields chunks of approximately CHUNK_SIZE bytes (5 MB).
 */
export async function* streamXmlFromZip(
	buffer: ArrayBuffer,
): AsyncGenerator<Uint8Array, void, void> {
	const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)));
	yield* streamXmlFromZipReader(reader);
}

/**
 * Stream XML from a ZipReader, yielding chunks.
 * Works with any zip.js Reader (Uint8ArrayReader, HttpRangeReader, R2RangeReader, etc.)
 */
async function* streamXmlFromZipReader(
	reader: ZipReader<unknown>,
): AsyncGenerator<Uint8Array, void, void> {
	try {
		const entries = await reader.getEntries();
		let xmlEntry: FileEntry | null = null;
		for (const entry of entries) {
			if (isFileEntry(entry) && entry.filename.toLowerCase().endsWith(".xml")) {
				xmlEntry = entry;
				break;
			}
		}

		if (!xmlEntry) {
			console.warn("ZIP parse failed: no XML entry found");
			return;
		}

		const writer = new ChunkingWriter();
		await xmlEntry.getData(writer);
		for (const chunk of writer.getChunks()) {
			yield chunk;
		}
	} finally {
		await reader.close();
	}
}

/**
 * Fetch a single USC title and stream XML content as chunks.
 * Returns an async generator yielding Uint8Array chunks, or null if fetch fails.
 * Uses HTTP range requests / R2 range requests to avoid loading entire ZIP into memory.
 * Check R2 first and cache the original response.
 */
export async function fetchUSCTitleStreaming(
	url: string,
	storage: R2Bucket,
): Promise<AsyncGenerator<Uint8Array, void, void> | null> {
	const filename = getFilenameFromUrl(url);
	const r2Key = `${USC_R2_PREFIX}${filename}`;
	const isZip = filename.toLowerCase().endsWith(".zip");

	// Check R2 first if storage is available
	const head = await storage.head(r2Key);
	if (head) {
		console.log(`  -> Found in R2: ${r2Key}`);
		if (isZip) {
			// Use R2 range reader - never loads full ZIP into memory
			const r2Reader = new R2RangeReader(storage, r2Key, head.size);
			const zipReader = new ZipReader(r2Reader);
			return streamXmlFromZipReader(zipReader);
		}
		// For raw XML, stream from R2 body
		const obj = await storage.get(r2Key);
		if (obj?.body) {
			return streamFromReadableStream(obj.body);
		}
	}

	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "fastlaw-ingest/1.0" },
		});

		if (!response.ok) {
			console.warn(`Failed to fetch ${url}: ${response.status}`);
			return null;
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.toLowerCase().includes("text/html")) {
			console.warn(`Skipping ${url}: got text/html response`);
			return null;
		}

		const urlIsZip = isZip || contentType.toLowerCase().includes("zip");

		if (urlIsZip) {
			// Download full file, save to R2, then release buffer and stream from R2
			const buffer = await response.arrayBuffer();
			const size = buffer.byteLength;

			if (storage) {
				await storage.put(r2Key, buffer);
				console.log(`  -> Saved to R2: ${r2Key}`);
				// Now stream from R2 using range requests (buffer can be GC'd)
				const r2Reader = new R2RangeReader(storage, r2Key, size);
				const zipReader = new ZipReader(r2Reader);
				return streamXmlFromZipReader(zipReader);
			}
		}

		// For raw XML, stream the response body
		if (!response.body) {
			console.warn(`Failed to fetch ${url}: no response body`);
			return null;
		}

		return streamFromReadableStream(response.body);
	} catch (error) {
		console.error(`Error fetching ${url}:`, error);
		return null;
	}
}

/**
 * Convert a ReadableStream to an async generator of Uint8Array chunks.
 */
async function* streamFromReadableStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
