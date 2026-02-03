import {
	type Entry,
	type FileEntry,
	TextWriter,
	Uint8ArrayReader,
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

const FALLBACK_INDIVIDUAL_BASE =
	"https://uscode.house.gov/download/releasepoints/us/pl";

const XML_TITLE_LINK_RE = /xml_usc(?!all)(\d{2}[a-z]?)@/i;

/**
 * Get list of available USC title XML URLs by crawling the download page.
 */
export async function getUSCTitleUrls(): Promise<string[]> {
	const html = await fetchDownloadPageHtml();
	if (!html) {
		return buildFallbackTitleUrls();
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
		return buildFallbackTitleUrls();
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
 * Fetch a single USC title XML file
 * If storage is provided, checks R2 first and caches the original response (zip or xml)
 */
export async function fetchUSCTitle(
	url: string,
	storage?: R2Bucket,
): Promise<string | null> {
	const filename = getFilenameFromUrl(url);
	const r2Key = `${USC_R2_PREFIX}${filename}`;

	// Check R2 first if storage is available
	if (storage) {
		const existing = await storage.get(r2Key);
		if (existing) {
			console.log(`  -> Found in R2: ${r2Key}`);
			if (filename.toLowerCase().endsWith(".zip")) {
				const buffer = await existing.arrayBuffer();
				return extractXmlFromZip(buffer);
			}
			return existing.text();
		}
	}

	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": "fastlaw-ingest/1.0",
			},
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

		const isZip = isZipResponse(url, response);
		const buffer = await response.arrayBuffer();

		// Save original response to R2 if storage is available
		if (storage) {
			await storage.put(r2Key, buffer);
			console.log(`  -> Saved to R2: ${r2Key}`);
		}

		if (isZip) {
			return extractXmlFromZip(buffer);
		}
		return new TextDecoder().decode(buffer);
	} catch (error) {
		console.error(`Error fetching ${url}:`, error);
		return null;
	}
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
 * Fetch all USC titles
 * Returns a map of title number -> XML content
 *
 * Note: This can be slow and may hit CF Worker limits.
 * Consider fetching titles in batches for production use.
 *
 * If storage is provided, caches fetched XML to R2 and checks R2 before downloading.
 */
export async function fetchAllUSCTitles(
	maxTitles = 54,
	delayMs = 100,
	storage?: R2Bucket,
): Promise<Map<string, string>> {
	const results = new Map<string, string>();
	const urls = (await getUSCTitleUrls()).slice(0, maxTitles);

	for (const url of urls) {
		const titleNum = getTitleNumFromUrl(url);
		if (!titleNum) continue;

		console.log(`Fetching USC Title ${titleNum}...`);
		const xml = await fetchUSCTitle(url, storage);

		if (xml) {
			results.set(titleNum, xml);
			console.log(`  -> Got ${xml.length} bytes`);
		}

		// Delay between requests (skip if retrieved from cache)
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return results;
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

function buildFallbackTitleUrls(): string[] {
	const titles: string[] = [];

	for (let i = 1; i <= 54; i++) {
		const paddedNum = i.toString().padStart(2, "0");
		titles.push(`${FALLBACK_INDIVIDUAL_BASE}/usc${paddedNum}.xml`);
	}

	return titles;
}

function isZipResponse(url: string, response: Response): boolean {
	if (url.toLowerCase().endsWith(".zip")) return true;
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.toLowerCase().includes("zip");
}

async function extractXmlFromZip(buffer: ArrayBuffer): Promise<string | null> {
	const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)));

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
			return null;
		}

		return await xmlEntry.getData(new TextWriter());
	} finally {
		await reader.close();
	}
}

function isFileEntry(entry: Entry): entry is FileEntry {
	return entry.directory === false;
}

/**
 * Alternative: Fetch USC data from a pre-processed R2 bucket
 * This is more reliable for production as it avoids external fetch issues
 */
export async function fetchUSCFromR2(
	storage: R2Bucket,
	prefix = "usc_raw/",
): Promise<Map<string, string>> {
	const results = new Map<string, string>();

	const list = await storage.list({ prefix });

	for (const object of list.objects) {
		const key = object.key;
		const titleNum = key.replace(prefix, "").replace(".xml", "");

		const obj = await storage.get(key);
		if (obj) {
			const xml = await obj.text();
			results.set(titleNum, xml);
		}
	}

	return results;
}
