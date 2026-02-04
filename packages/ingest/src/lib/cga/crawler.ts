import { streamFromReadableStream } from "../streaming";
import {
	type ChapterInfo,
	type ParsedSection,
	parseCgaPage,
	type TitleInfo,
} from "./parser";
import {
	type CrawlerConfig,
	consoleLogger,
	DEFAULT_CRAWLER_CONFIG,
	type Logger,
	parsePageUrl,
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
	onPage?: (page: CrawledPage) => Promise<void>,
): Promise<CrawlResult> {
	const cfg = { ...DEFAULT_CRAWLER_CONFIG, ...config };

	const seen = new Set<string>();
	const stack: string[] = [startUrl];
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

	async function processUrl(url: string): Promise<void> {
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		try {
			logger.info(`Fetching: ${url}`);
			const controller = new AbortController();
			timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);
			const response = await doFetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": cfg.userAgent,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Encoding": "gzip, deflate",
				},
			});
			clearTimeout(timeoutId);
			timeoutId = null;

			logger.debug(`Response status for ${url}: ${response.status}`);

			if (!response.ok) {
				logger.warn(
					`Failed to fetch ${url}: ${response.status} ${response.statusText}`,
				);
				return;
			}

			if (!response.body) {
				throw new Error(`Empty response body for ${url}`);
			}

			pagesCrawled++;

			const parsedPage = await parseCgaPage(
				streamFromReadableStream(response.body),
				url,
			);
			const crawledPage: CrawledPage = {
				url: parsedPage.url,
				type: parsedPage.type,
				titleInfo: parsedPage.titleInfo,
				chapterInfo: parsedPage.chapterInfo,
				sections: parsedPage.sections,
			};

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

			if (onPage) {
				await onPage(crawledPage);
			}

			// Extract and queue new links
			for (const link of parsedPage.links) {
				const linkType = parsePageUrl(link).type;
				if (
					linkType !== "title" &&
					linkType !== "chapter" &&
					linkType !== "article"
				) {
					continue;
				}
				if (seen.has(link)) {
					continue;
				}
				seen.add(link);
				stack.push(link);
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				logger.error(`Timeout fetching ${url}`);
			} else {
				logger.error(`Error fetching ${url}:`, error);
			}
		} finally {
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}
		}
	}

	seen.add(startUrl);

	while (stack.length > 0 && pagesCrawled < cfg.maxPages) {
		const batch = stack.splice(-cfg.concurrency);
		await Promise.all(batch.map((url) => processUrl(url)));

		if (pagesCrawled % 50 === 0) {
			logger.info(
				`Progress: ${pagesCrawled} pages crawled, ${stack.length} URLs in stack, ${seen.size} total seen`,
			);
		}
	}

	return result;
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
