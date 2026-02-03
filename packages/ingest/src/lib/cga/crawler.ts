import {
	ChapterParser,
	extractLinks,
	formatText,
	type ParsedSection,
} from "./parser";

/**
 * Unified crawled page data - parsed during crawl, no raw HTML stored
 */
export interface CrawledPage {
	url: string;
	type: "title" | "chapter" | "article" | "index" | "other";
	titleInfo?: TitleInfo;
	chapterInfo?: ChapterInfo;
	sections: ParsedSection[];
}

/**
 * Result from crawling CGA
 */
export interface CrawlResult {
	titles: Map<string, TitleInfo>;
	chapters: Map<string, ChapterInfo>;
	sections: ParsedSection[];
}

export interface TitleInfo {
	titleId: string;
	titleName: string | null;
	sourceUrl: string;
}

export interface ChapterInfo {
	chapterId: string;
	chapterTitle: string | null;
	titleId: string;
	sourceUrl: string;
}

/**
 * BFS crawl of CGA statute pages with integrated parsing.
 * Returns structured data instead of raw HTML.
 *
 * @param fetcher - CF Workers CA fetcher binding (deployed) or undefined (local dev with NODE_EXTRA_CA_CERTS)
 * @param maxPages - Maximum number of pages to crawl
 * @param delayMs - Delay between requests (not used with concurrency)
 * @param concurrency - Number of concurrent requests
 */
export async function crawlCGA(
	startUrl: string,
	fetcher?: Fetcher,
	maxPages = 1000,
	_delayMs = 0,
	concurrency = 20,
): Promise<CrawlResult> {
	const seen = new Set<string>();
	const queue: string[] = [startUrl];
	const result: CrawlResult = {
		titles: new Map(),
		chapters: new Map(),
		sections: [],
	};
	let pagesCrawled = 0;

	// Use fetcher.fetch if available (deployed worker), otherwise regular fetch (local dev)
	const doFetch = fetcher
		? (url: string, init?: RequestInit) => fetcher.fetch(url, init)
		: fetch;

	// Semaphore for concurrency control
	let _activeCount = 0;
	const semaphore = new Semaphore(concurrency);

	async function processUrl(url: string): Promise<void> {
		await semaphore.acquire();
		_activeCount++;

		try {
			console.log(`Fetching: ${url}`);
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
			const response = await doFetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": "fastlaw-ingest/1.0",
					Accept: "text/html,application/xhtml+xml",
					"Accept-Encoding": "gzip, deflate",
				},
			});
			clearTimeout(timeoutId);

			console.log(`Response status for ${url}: ${response.status}`);

			if (!response.ok) {
				console.warn(
					`Failed to fetch ${url}: ${response.status} ${response.statusText}`,
				);
				return;
			}

			const html = await response.text();
			console.log(`Got ${html.length} bytes from ${url}`);

			pagesCrawled++;

			// Parse the HTML once to extract content AND links
			const crawledPage = parsePage(html, url);

			// Store the parsed data
			if (crawledPage.type === "title" && crawledPage.titleInfo) {
				result.titles.set(crawledPage.titleInfo.titleId, crawledPage.titleInfo);
			} else if (crawledPage.type === "chapter" && crawledPage.chapterInfo) {
				result.chapters.set(
					crawledPage.chapterInfo.chapterId,
					crawledPage.chapterInfo,
				);
				// Add sections with correct parent
				for (const section of crawledPage.sections) {
					section.sourceUrl = url; // Ensure source URL is set
					result.sections.push(section);
				}
			}

			// Extract and queue new links
			const links = extractLinks(html, url);
			if (links.length > 0) {
				queue.push(...links.filter((link) => !seen.has(link)));
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				console.error(`Timeout fetching ${url}`);
			} else {
				console.error(`Error fetching ${url}:`, error);
			}
		} finally {
			_activeCount--;
			semaphore.release();
		}
	}

	// Process queue with concurrency control
	// First, process the start URL synchronously to get initial links
	const nextUrl = queue.shift();
	if (nextUrl && !seen.has(nextUrl)) {
		seen.add(nextUrl);
		await processUrl(nextUrl);
	}

	// Then process remaining queue with concurrency control
	while (queue.length > 0 && pagesCrawled < maxPages) {
		const batch: string[] = [];
		const pendingPromises: Promise<void>[] = [];

		// Collect up to 'concurrency' URLs for this batch
		while (batch.length < concurrency && queue.length > 0) {
			const url = queue.shift();
			if (!url) continue;
			if (seen.has(url)) continue;
			seen.add(url);
			batch.push(url);
		}

		if (batch.length === 0) break;

		// Process all URLs in this batch concurrently
		for (const url of batch) {
			pendingPromises.push(processUrl(url));
		}

		// Wait for this batch to complete
		await Promise.all(pendingPromises);

		// Log progress
		if (pagesCrawled % 50 === 0) {
			console.log(
				`Progress: ${pagesCrawled} pages crawled, ${queue.length} URLs in queue, ${seen.size} total seen`,
			);
		}
	}

	return result;
}

/**
 * Parse a single page, extracting content and determining page type.
 * This is called during the crawl, so we parse HTML only once.
 */
function parsePage(html: string, url: string): CrawledPage {
	const page: CrawledPage = {
		url,
		type: "other",
		sections: [],
	};

	// Determine page type from URL
	const filename = url.split("/").pop() || "";
	if (filename.startsWith("title_") && filename.endsWith(".htm")) {
		page.type = "title";
		page.titleInfo = parseTitlePage(html, url);
	} else if (filename.startsWith("chap_") && filename.endsWith(".htm")) {
		page.type = "chapter";
		page.chapterInfo = parseChapterPage(html, url, page.sections);
	} else if (filename.startsWith("art_") && filename.endsWith(".htm")) {
		page.type = "article";
		page.chapterInfo = parseChapterPage(html, url, page.sections);
	}

	return page;
}

/**
 * Parse a title page to extract title name
 */
function parseTitlePage(html: string, url: string): TitleInfo {
	const titleIdMatch = url.match(/title_([^.]+)\.htm/i);
	const titleId = titleIdMatch?.[1] || "";

	// Extract title from <title> tag
	const titleMatch = html.match(/<title>(.*?)<\/title>/is);
	let titleName: string | null = null;

	if (titleMatch) {
		const titleText = titleMatch[1].replace(/<[^>]+>/g, "");
		titleName = decodeHtmlEntities(titleText).trim();

		// Extract name from "Title X - Name" format
		const match = titleName.match(/^Title\s+[\w]+?\s*-\s*(.+)$/i);
		if (match) {
			titleName = match[1].trim() || null;
		} else {
			titleName = null;
		}
	}

	return {
		titleId,
		titleName,
		sourceUrl: url,
	};
}

/**
 * Parse a chapter page to extract chapter title and sections
 */
function parseChapterPage(
	html: string,
	url: string,
	sections: ParsedSection[],
): ChapterInfo {
	const parser = new ChapterParser();
	parser.parse(html);

	// Extract chapter info
	const chapterTitle = parser.getChapterTitle();
	const chapterIdMatch = url.match(/chap_([^.]+)\.htm/i);
	const chapterId = chapterIdMatch?.[1] || "";

	// Extract title ID from section data
	let titleId: string | null = null;
	const rawSections = parser.getSections();

	// Try to extract title ID from section IDs
	for (const section of rawSections) {
		// Match patterns like sec_4-125, secs_4-125, sec_04-125, sec_19a-125
		const match = section.sectionId.match(/sec[s]?_([\da-zA-Z]+)/);
		if (match) {
			titleId = match[1];
			break;
		}
	}

	// If no title ID from sections, try to extract from chapter title
	// Chapter titles are like "Department of Administrative Services (title 4)" or "Chapter 4 - ..."
	if (!titleId && chapterTitle) {
		const titleMatch = chapterTitle.match(/\(title\s*(\d+)\)|title\s*(\d+)/i);
		if (titleMatch) {
			titleId = titleMatch[1] || titleMatch[2];
		}
	}

	// Convert parsed sections to our format
	for (let i = 0; i < rawSections.length; i++) {
		const sectionData = convertSection(rawSections[i], url, chapterId, i);
		sections.push(sectionData);
	}

	return {
		chapterId,
		chapterTitle,
		titleId: titleId || "",
		sourceUrl: url,
	};
}

/**
 * Parse a section label like "Sec. 4-125. Title of section." into parts
 */
function parseSectionLabel(label: string): {
	sectionNumber: string | null;
	title: string | null;
} {
	const match = label.match(/^Secs?\.\s+([^.]+)\.\s*(.*)$/);
	if (!match) {
		return { sectionNumber: null, title: label.replace(/\.$/, "").trim() };
	}
	const sectionNumber = match[1].trim();
	let title = match[2].trim();
	title = title.replace(/\.$/, "").trim();
	return { sectionNumber, title: title || null };
}

/**
 * Normalize designator (strip leading zeros, lowercase)
 */
function normalizeDesignator(value: string | null): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

/**
 * Convert ChapterParser section data to ParsedSection
 */
function convertSection(
	sectionData: {
		sectionId: string;
		name: string;
		parts: {
			body: string[];
			history_short: string[];
			history_long: string[];
			citations: string[];
			see_also: string[];
		};
	},
	sourceUrl: string,
	chapterId: string,
	sortOrder: number,
): ParsedSection {
	const label = sectionData.name || sectionData.sectionId;
	const { sectionNumber, title: cleanTitle } = parseSectionLabel(label);
	const normalizedChapterNum = chapterId
		? normalizeDesignator(chapterId.replace("chap_", "")) ||
			chapterId.replace("chap_", "")
		: null;

	return {
		stringId: `cgs/section/${sectionData.sectionId}`,
		levelName: "section",
		levelIndex: 2,
		name: cleanTitle,
		path: `/statutes/cgs/section/${sectionData.sectionId}`,
		readableId: sectionNumber,
		body: formatText(sectionData.parts.body || []),
		historyShort: formatText(sectionData.parts.history_short || []) || null,
		historyLong: formatText(sectionData.parts.history_long || []) || null,
		citations: formatText(sectionData.parts.citations || []) || null,
		parentStringId: normalizedChapterNum
			? `cgs/chapter/${normalizedChapterNum}`
			: null,
		sortOrder,
		sourceUrl,
	};
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
	const entities: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '"',
		"&#39;": "'",
		"&apos;": "'",
		"&nbsp;": " ",
	};
	return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
	private permits: number;
	private waiters: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	acquire(): Promise<void> {
		return new Promise((resolve) => {
			if (this.permits > 0) {
				this.permits--;
				resolve();
			} else {
				this.waiters.push(resolve);
			}
		});
	}

	release(): void {
		if (this.waiters.length > 0) {
			const next = this.waiters.shift();
			if (next) {
				next(); // Give permit directly to waiter
			}
		} else {
			this.permits++;
		}
	}
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
