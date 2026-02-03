/**
 * Shared utilities for CGA crawler/parser
 */

/**
 * Simple semaphore for concurrency control
 */
export class Semaphore {
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
 * Decode common HTML entities
 */
export function decodeHtmlEntities(text: string): string {
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
 * Logger interface for consistent error handling
 */
export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * Default console logger
 */
export const consoleLogger: Logger = {
	debug: (message, ...args) => console.debug(`[CGA] ${message}`, ...args),
	info: (message, ...args) => console.log(`[CGA] ${message}`, ...args),
	warn: (message, ...args) => console.warn(`[CGA] ${message}`, ...args),
	error: (message, ...args) => console.error(`[CGA] ${message}`, ...args),
};

/**
 * Silent logger for testing
 */
export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * Crawler configuration
 */
export interface CrawlerConfig {
	/** Maximum number of pages to crawl */
	maxPages: number;
	/** Number of concurrent requests */
	concurrency: number;
	/** Request timeout in milliseconds */
	timeoutMs: number;
	/** User-Agent header for requests */
	userAgent: string;
}

/**
 * Default crawler configuration
 */
export const DEFAULT_CRAWLER_CONFIG: CrawlerConfig = {
	maxPages: 1000,
	concurrency: 20,
	timeoutMs: 30000,
	userAgent: "fastlaw-ingest/1.0",
};

/**
 * Page URL parsing result - discriminated union for URL types
 */
export type PageUrlInfo =
	| { type: "title"; id: string }
	| { type: "chapter"; id: string }
	| { type: "article"; id: string }
	| { type: "index" }
	| { type: "other" };

/**
 * Parse a CGA page URL to determine its type and extract relevant ID
 */
export function parsePageUrl(url: string): PageUrlInfo {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return { type: "other" };
	}

	const filename = pathname.split("/").pop() || "";

	// Match title_*.htm files
	const titleMatch = filename.match(/^title_([^.]+)\.htm$/i);
	if (titleMatch) {
		return { type: "title", id: titleMatch[1] };
	}

	// Match chap_*.htm files
	const chapterMatch = filename.match(/^chap_([^.]+)\.htm$/i);
	if (chapterMatch) {
		return { type: "chapter", id: chapterMatch[1] };
	}

	// Match art_*.htm files
	const articleMatch = filename.match(/^art_([^.]+)\.htm$/i);
	if (articleMatch) {
		return { type: "article", id: articleMatch[1] };
	}

	// Match index files
	if (filename === "titles.htm" || filename === "index.htm") {
		return { type: "index" };
	}

	return { type: "other" };
}
