import { ZipReaderStream } from "@zip.js/zip.js";
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
const RELEASE_POINT_RE = /@(\d+-[^./?#\s]+)/i;

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
const USC_XML_R2_PREFIX = `${USC_R2_PREFIX}xml/`;
const MULTIPART_PART_SIZE = 5 * 1024 * 1024;

/**
 * Extract filename from URL for R2 storage key
 */
function getFilenameFromUrl(url: string): string {
	const urlObj = new URL(url);
	const pathname = urlObj.pathname;
	return pathname.split("/").pop() ?? "";
}

function getXmlCacheKey(url: string): string {
	const filename = getFilenameFromUrl(url);
	if (filename.toLowerCase().endsWith(".zip")) {
		return `${USC_XML_R2_PREFIX}${filename.replace(/\.zip$/i, ".xml")}`;
	}
	if (filename.toLowerCase().endsWith(".xml")) {
		return `${USC_XML_R2_PREFIX}${filename}`;
	}
	return `${USC_XML_R2_PREFIX}${filename}.xml`;
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

/**
 * Extract House release point from a USC URL (e.g. "119-73not60").
 */
export function getReleasePointFromUrl(url: string): string | null {
	const match = url.match(RELEASE_POINT_RE);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Validate and return a single release point across all USC title URLs.
 */
export function getReleasePointFromTitleUrls(urls: string[]): string {
	const releasePoints = new Set(
		urls
			.map((url) => getReleasePointFromUrl(url))
			.filter((value): value is string => value !== null),
	);

	if (releasePoints.size === 0) {
		throw new Error("Failed to determine USC release point from title URLs.");
	}

	if (releasePoints.size > 1) {
		throw new Error(
			`Found multiple USC release points in one crawl: ${[...releasePoints].join(", ")}`,
		);
	}

	return [...releasePoints][0];
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

/**
 * Extract XML from a ZIP file as streaming chunks of Uint8Array.
 * Yields chunks as the ZIP entry is decompressed.
 */
export async function* streamXmlFromZip(
	buffer: ArrayBuffer,
): AsyncGenerator<Uint8Array, void, void> {
	const bytes = new Uint8Array(buffer);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	yield* streamXmlFromZipStream(stream);
}

/**
 * Stream XML from a ZIP byte stream using ZipReaderStream.
 */
async function* streamXmlFromZipStream(
	zipStream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const entryStream = zipStream.pipeThrough(new ZipReaderStream<Uint8Array>());
	const reader = entryStream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.directory) continue;
			if (!value.filename.toLowerCase().endsWith(".xml")) continue;
			if (!value.readable) {
				throw new Error(`ZIP entry has no readable stream: ${value.filename}`);
			}
			yield* streamFromReadableStream(value.readable);
			return;
		}
		console.warn("ZIP parse failed: no XML entry found");
	} finally {
		reader.releaseLock();
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
	const xmlCacheKey = getXmlCacheKey(url);
	const isZip = filename.toLowerCase().endsWith(".zip");

	// Read extracted XML cache first.
	const cachedXml = await storage.get(xmlCacheKey);
	if (cachedXml?.body) {
		console.log(`  -> Found extracted XML in R2: ${xmlCacheKey}`);
		return streamFromReadableStream(cachedXml.body);
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
			// Stream unzip from network, then cache extracted XML via multipart upload.
			if (!response.body) {
				console.warn(`Failed to fetch ${url}: no response body`);
				return null;
			}
			return streamWithMultipartCache(
				storage,
				xmlCacheKey,
				streamXmlFromZipStream(response.body),
			);
		}

		// For raw XML, stream with multipart cache upload.
		if (!response.body) {
			console.warn(`Failed to fetch ${url}: no response body`);
			return null;
		}
		return streamWithMultipartCache(
			storage,
			xmlCacheKey,
			streamFromReadableStream(response.body),
		);
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

async function* streamWithMultipartCache(
	storage: R2Bucket,
	key: string,
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const upload = await storage.createMultipartUpload(key);
	type UploadedPart = Awaited<ReturnType<R2MultipartUpload["uploadPart"]>>;
	const uploadedParts: UploadedPart[] = [];
	const bufferedChunks: Uint8Array[] = [];
	let bufferedSize = 0;
	let partNumber = 1;
	let completed = false;

	try {
		for await (const chunk of chunks) {
			bufferedChunks.push(chunk);
			bufferedSize += chunk.length;
			while (bufferedSize >= MULTIPART_PART_SIZE) {
				const partData = consumeBufferedBytes(
					bufferedChunks,
					MULTIPART_PART_SIZE,
				);
				bufferedSize -= MULTIPART_PART_SIZE;
				const uploaded = await upload.uploadPart(partNumber, partData);
				uploadedParts.push(uploaded);
				partNumber += 1;
			}
			yield chunk;
		}

		if (bufferedSize > 0) {
			const finalPartData = consumeBufferedBytes(bufferedChunks, bufferedSize);
			bufferedSize = 0;
			const uploaded = await upload.uploadPart(partNumber, finalPartData);
			uploadedParts.push(uploaded);
		}

		if (uploadedParts.length === 0) {
			await upload.abort();
			await storage.put(key, new Uint8Array());
		} else {
			await upload.complete(uploadedParts);
		}
		completed = true;
		console.log(`  -> Saved extracted XML to R2: ${key}`);
	} catch (error) {
		console.error(`Failed to cache extracted XML: ${key}`, error);
		throw error;
	} finally {
		if (!completed) {
			try {
				await upload.abort();
			} catch {}
		}
	}
}

function consumeBufferedBytes(chunks: Uint8Array[], size: number): Uint8Array {
	const output = new Uint8Array(size);
	let written = 0;
	while (written < size) {
		const chunk = chunks.shift();
		if (!chunk) {
			throw new Error(`Buffer underflow while consuming ${size} bytes`);
		}
		const remaining = size - written;
		if (chunk.length <= remaining) {
			output.set(chunk, written);
			written += chunk.length;
			continue;
		}
		output.set(chunk.subarray(0, remaining), written);
		chunks.unshift(chunk.subarray(remaining));
		written += remaining;
	}
	return output;
}
