import { Parser } from "htmlparser2";

const BASE_URL = "https://www.cga.ct.gov";
const ALLOWED_PREFIX = "/current/pub/";

/**
 * Extract links from HTML content
 */
export function extractLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];

	const parser = new Parser(
		{
			onopentag: (name, attribs) => {
				if (name === "a" && attribs.href) {
					const normalized = normalizeLink(attribs.href, baseUrl);
					if (normalized) {
						links.push(normalized);
					}
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
 * Normalize a link URL, filtering to only CGA statute pages
 */
function normalizeLink(href: string, baseUrl: string): string | null {
	if (href.startsWith("mailto:") || href.startsWith("javascript:")) {
		return null;
	}

	// Resolve relative URL
	let fullUrl: string;
	try {
		fullUrl = new URL(href, baseUrl).toString();
	} catch {
		return null;
	}

	const parsed = new URL(fullUrl);

	// Only allow http/https
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}

	// Only allow CGA domain
	const baseHost = new URL(BASE_URL).hostname;
	if (parsed.hostname !== baseHost) {
		return null;
	}

	// Only allow paths under /current/pub/
	if (!parsed.pathname.startsWith(ALLOWED_PREFIX)) {
		return null;
	}

	// Strip fragment
	parsed.hash = "";
	return parsed.toString();
}

/**
 * BFS crawl of CGA statute pages.
 * Returns a map of URL -> HTML content.
 *
 * Note: This is designed to work within CF Worker constraints.
 * For large crawls, consider breaking into smaller batches.
 */
export async function crawlCGA(
	startUrl: string,
	maxPages = 1000,
	delayMs = 100,
): Promise<Map<string, string>> {
	const seen = new Set<string>();
	const queue: string[] = [startUrl];
	const results = new Map<string, string>();

	while (queue.length > 0 && results.size < maxPages) {
		const url = queue.shift();
		if (!url || seen.has(url)) continue;
		seen.add(url);

		try {
			const response = await fetch(url, {
				headers: {
					"User-Agent": "fastlaw-ingest/1.0",
				},
			});

			if (!response.ok) {
				console.warn(`Failed to fetch ${url}: ${response.status}`);
				continue;
			}

			const html = await response.text();
			results.set(url, html);

			// Extract and queue new links
			const links = extractLinks(html, url);
			for (const link of links) {
				if (!seen.has(link)) {
					queue.push(link);
				}
			}

			// Small delay to be polite
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		} catch (error) {
			console.error(`Error fetching ${url}:`, error);
		}
	}

	return results;
}

/**
 * Determine the chapter ID from a URL path
 */
export function getChapterIdFromUrl(url: string): string | null {
	const parsed = new URL(url);
	const filename = parsed.pathname.split("/").pop();
	if (!filename) return null;

	// Match chap_*.htm files
	const match = filename.match(/^(chap_[^.]+)\.htm$/i);
	if (match) {
		return match[1];
	}

	return null;
}

/**
 * Determine the title ID from a URL path
 */
export function getTitleIdFromUrl(url: string): string | null {
	const parsed = new URL(url);
	const filename = parsed.pathname.split("/").pop();
	if (!filename) return null;

	// Match title_*.htm files
	const match = filename.match(/^title_([^.]+)\.htm$/i);
	if (match) {
		return match[1];
	}

	return null;
}

/**
 * Check if URL is a chapter file
 */
export function isChapterUrl(url: string): boolean {
	return getChapterIdFromUrl(url) !== null;
}

/**
 * Check if URL is a title file
 */
export function isTitleUrl(url: string): boolean {
	return getTitleIdFromUrl(url) !== null;
}
