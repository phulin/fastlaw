import {
	type ChapterInfo,
	type ChapterParseResult,
	extractLinks,
	type ParsedSection,
	parseChapterPage,
	parseTitlePage,
	type TitleInfo,
} from "./parser";
import {
	type CrawlerConfig,
	consoleLogger,
	DEFAULT_CRAWLER_CONFIG,
	type Logger,
	parsePageUrl,
	Semaphore,
} from "./utils";

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

/**
 * BFS crawl of CGA statute pages with integrated parsing.
 * Returns structured data instead of raw HTML.
 *
 * @param startUrl - URL to start crawling from
 * @param fetcher - CF Workers CA fetcher binding (deployed) or undefined (local dev with NODE_EXTRA_CA_CERTS)
 * @param config - Crawler configuration (optional, uses defaults)
 * @param logger - Logger instance (optional, uses console logger)
 */
export async function crawlCGA(
	startUrl: string,
	fetcher?: Fetcher,
	config: Partial<CrawlerConfig> = {},
	logger: Logger = consoleLogger,
): Promise<CrawlResult> {
	const cfg = { ...DEFAULT_CRAWLER_CONFIG, ...config };

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

	const semaphore = new Semaphore(cfg.concurrency);

	async function processUrl(url: string): Promise<void> {
		await semaphore.acquire();

		try {
			logger.info(`Fetching: ${url}`);
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);
			const response = await doFetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": cfg.userAgent,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Encoding": "gzip, deflate",
				},
			});
			clearTimeout(timeoutId);

			logger.debug(`Response status for ${url}: ${response.status}`);

			if (!response.ok) {
				logger.warn(
					`Failed to fetch ${url}: ${response.status} ${response.statusText}`,
				);
				return;
			}

			const html = await response.text();
			logger.debug(`Got ${html.length} bytes from ${url}`);

			pagesCrawled++;

			// Parse the HTML once to extract content AND links
			const crawledPage = parsePage(html, url);

			// Store the parsed data
			if (crawledPage.type === "title" && crawledPage.titleInfo) {
				result.titles.set(crawledPage.titleInfo.titleId, crawledPage.titleInfo);
			} else if (
				(crawledPage.type === "chapter" || crawledPage.type === "article") &&
				crawledPage.chapterInfo
			) {
				const chapterKey = `${crawledPage.chapterInfo.type}_${crawledPage.chapterInfo.chapterId}`;
				result.chapters.set(chapterKey, crawledPage.chapterInfo);
				// Add sections with correct source URL
				for (const section of crawledPage.sections) {
					section.sourceUrl = url;
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
				logger.error(`Timeout fetching ${url}`);
			} else {
				logger.error(`Error fetching ${url}:`, error);
			}
		} finally {
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
	while (queue.length > 0 && pagesCrawled < cfg.maxPages) {
		const batch: string[] = [];
		const pendingPromises: Promise<void>[] = [];

		// Collect up to 'concurrency' URLs for this batch
		while (batch.length < cfg.concurrency && queue.length > 0) {
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
			logger.info(
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
	const urlInfo = parsePageUrl(url);

	const page: CrawledPage = {
		url,
		type: urlInfo.type === "index" ? "index" : urlInfo.type,
		sections: [],
	};

	switch (urlInfo.type) {
		case "title":
			page.titleInfo = parseTitlePage(html, url);
			break;
		case "chapter":
		case "article": {
			const result: ChapterParseResult = parseChapterPage(
				html,
				url,
				urlInfo.id,
				urlInfo.type,
			);
			page.chapterInfo = result.info;
			page.sections = result.sections;
			break;
		}
	}

	return page;
}

// ============ URL Helper Functions (for backwards compatibility) ============

/**
 * Determine the chapter ID from a URL path
 */
export function getChapterIdFromUrl(url: string): string | null {
	const info = parsePageUrl(url);
	if (info.type === "chapter") {
		return `chap_${info.id}`;
	}
	return null;
}

/**
 * Determine the title ID from a URL path
 */
export function getTitleIdFromUrl(url: string): string | null {
	const info = parsePageUrl(url);
	if (info.type === "title") {
		return info.id;
	}
	return null;
}

/**
 * Check if URL is a chapter file
 */
export function isChapterUrl(url: string): boolean {
	return parsePageUrl(url).type === "chapter";
}

/**
 * Check if URL is a title file
 */
export function isTitleUrl(url: string): boolean {
	return parsePageUrl(url).type === "title";
}
