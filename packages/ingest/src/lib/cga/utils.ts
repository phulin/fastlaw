/**
 * Shared utilities for CGA crawler/parser
 */

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
