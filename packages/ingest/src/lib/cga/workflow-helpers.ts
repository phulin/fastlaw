/**
 * Helper functions for CGA Cloudflare Workflow
 */

import { streamFromReadableStream } from "../streaming";
import {
	ChapterParser,
	formatText,
	type ParsedSection,
	parseLabel,
	type SectionData,
} from "./parser";
import { parsePageUrl } from "./utils";

/**
 * Extract the revision year from CGA HTML
 * Matches patterns like "Revised to January 1, 2025"
 */
export function extractVersionId(html: string): string {
	const patterns = [
		/revised\s+to\s+\w+\s+\d+,?\s+(\d{4})/i,
		/current\s+through\s+.*?(\d{4})/i,
		/as\s+of\s+.*?(\d{4})/i,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match) {
			return match[1];
		}
	}

	// Fallback to current year
	return new Date().getFullYear().toString();
}

/**
 * Extract filename from URL for R2 key construction
 */
export function extractFilename(url: string): string {
	const urlObj = new URL(url);
	const parts = urlObj.pathname.split("/");
	return parts[parts.length - 1] || "index.htm";
}

/**
 * Extract title page URLs from the root titles.htm page
 */
export function extractTitleUrls(html: string, baseUrl: string): string[] {
	const urls: string[] = [];
	const linkPattern = /href=["']([^"']*title_[^"']+\.htm)["']/gi;

	for (const match of html.matchAll(linkPattern)) {
		const absoluteUrl = new URL(match[1], baseUrl).toString();
		if (!urls.includes(absoluteUrl)) {
			urls.push(absoluteUrl);
		}
	}

	return urls;
}

/**
 * Extract chapter/article URLs from a title page
 */
export function extractChapterUrls(
	html: string,
	baseUrl: string,
): Array<{ url: string; type: "chapter" | "article" }> {
	const urls: Array<{ url: string; type: "chapter" | "article" }> = [];
	const seenUrls = new Set<string>();
	const linkPattern = /href=["']([^"']*(?:chap_|art_)[^"']+\.htm)["']/gi;

	for (const match of html.matchAll(linkPattern)) {
		const absoluteUrl = new URL(match[1], baseUrl).toString();
		if (seenUrls.has(absoluteUrl)) continue;
		seenUrls.add(absoluteUrl);

		const urlInfo = parsePageUrl(absoluteUrl);
		if (urlInfo.type === "chapter" || urlInfo.type === "article") {
			urls.push({ url: absoluteUrl, type: urlInfo.type });
		}
	}

	return urls;
}

/**
 * Parse title page to extract title ID and name
 */
export async function parseTitlePageForWorkflow(
	body: ReadableStream<Uint8Array>,
	url: string,
): Promise<{
	titleId: string;
	titleName: string | null;
	chapterUrls: Array<{ url: string; type: "chapter" | "article" }>;
}> {
	const decoder = new TextDecoder();
	let html = "";

	const reader = body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		html += decoder.decode(value, { stream: true });
	}
	html += decoder.decode();

	// Extract title ID from URL
	const titleIdMatch = url.match(/title_([^.]+)\.htm/i);
	const titleId = titleIdMatch?.[1] || "";

	// Extract title name from <title> tag
	let titleName: string | null = null;
	const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
	if (titleTagMatch) {
		const fullTitle = titleTagMatch[1].trim();
		// Match "Title X - Name" format
		const nameMatch = fullTitle.match(/^Title\s+[\w*]+\s*[-–—]\s*(.+)$/i);
		if (nameMatch) {
			titleName = nameMatch[1].trim();
		}
	}

	// Extract chapter URLs
	const chapterUrls = extractChapterUrls(html, url);

	return { titleId, titleName, chapterUrls };
}

/**
 * Parse chapter page - returns chapter info and section index for planning.
 */
export async function parseChapterPageForWorkflow(
	body: ReadableStream<Uint8Array>,
	url: string,
	_type: "chapter" | "article",
): Promise<{
	chapterId: string;
	chapterTitle: string | null;
	sections: Array<{
		sectionId: string;
		label: string | null;
		slug: string;
		sortOrder: number;
	}>;
}> {
	const parser = new ChapterParser();
	await parser.parse(streamFromReadableStream(body));

	const urlInfo = parsePageUrl(url);
	const urlChapterId =
		urlInfo.type === "chapter" || urlInfo.type === "article" ? urlInfo.id : "";

	const sectionLabels = parser.getSectionLabels();
	const sections = parser.getSections().map((section, index) => {
		const label = sectionLabels.get(section.sectionId) || section.sectionId;
		return {
			sectionId: section.sectionId,
			label,
			slug: normalizeSectionSlug(section.sectionId, label),
			sortOrder: index,
		};
	});

	return {
		chapterId: parser.getChapterNumber() || urlChapterId,
		chapterTitle: parser.getChapterTitle(),
		sections,
	};
}

/**
 * Parse sections in a specific index range from chapter HTML
 * Used by section batch steps to parse only their assigned sections
 */
export async function parseSectionsInRange(
	html: string,
	sourceUrl: string,
	startIndex: number,
	endIndex: number,
): Promise<ParsedSection[]> {
	const parser = new ChapterParser();
	await parser.parse(html);

	const allSections = parser.getSections();
	const urlInfo = parsePageUrl(sourceUrl);
	const chapterId =
		parser.getChapterNumber() ||
		(urlInfo.type === "chapter" || urlInfo.type === "article"
			? urlInfo.id
			: "");
	const type =
		urlInfo.type === "chapter" || urlInfo.type === "article"
			? urlInfo.type
			: "chapter";

	// Build ParsedSection objects for the requested range
	return buildSectionsFromParsedData(
		allSections.slice(startIndex, endIndex),
		parser.getSectionLabels(),
		chapterId,
		sourceUrl,
		type,
		startIndex,
	);
}

/**
 * Trim trailing chapter/part headings from body text
 */
function trimTrailingHeadings(bodyText: string): string {
	if (!bodyText) return bodyText;

	const lines = bodyText.split("\n");

	// Remove trailing blank lines
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	while (lines.length > 0) {
		const line = lines[lines.length - 1].trim();

		// Check for various heading patterns
		if (
			/^(?:PART|SUBPART|ARTICLE|CHAPTER)\s+[IVXLC\d]+$/.test(line) ||
			(/^[A-Z][A-Z\s\-,&]+$/.test(line) && line.length <= 80) ||
			/^\(([A-Z]|[IVXLC]+)\)$/.test(line)
		) {
			lines.pop();
			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}
			continue;
		}

		break;
	}

	return lines.join("\n").trim();
}

function normalizeSectionSlug(
	sectionId: string,
	label: string | null,
	parsedNumber?: string | null,
): string {
	const number = parsedNumber ?? parseLabel(label).number;
	return (number || sectionId.replace(/^sec[s]?_/, "")).replace(/\s+/g, "_");
}

/**
 * Build ParsedSection objects from parser data
 */
function buildSectionsFromParsedData(
	sections: SectionData[],
	labelMap: Map<string, string>,
	chapterId: string,
	sourceUrl: string,
	type: "chapter" | "article",
	startOffset = 0,
): ParsedSection[] {
	const results: ParsedSection[] = [];

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		const label = labelMap.get(section.sectionId) || section.sectionId;
		const { number, title } = parseLabel(label);

		const sectionName =
			title ||
			(label
				? label
						.replace(/^Secs?\.\s+/, "")
						.replace(/\.$/, "")
						.trim()
				: null);

		const textBlocks = {
			body: trimTrailingHeadings(formatText(section.parts.body)),
			historyShort: formatText(section.parts.history_short) || null,
			historyLong: formatText(section.parts.history_long) || null,
			citations: formatText(section.parts.citations) || null,
			seeAlso: formatText(section.parts.see_also) || null,
		};

		if (!textBlocks.body) {
			console.warn(
				`[CGA Parser] Empty body for section ${section.sectionId} in ${type} ${chapterId} (${sourceUrl})`,
			);
		}

		const normalizedNumber = normalizeSectionSlug(
			section.sectionId,
			label,
			number,
		);
		const readableId = normalizedNumber.replaceAll("_", " ");

		results.push({
			stringId: `cgs/section/${normalizedNumber}`,
			levelName: "section",
			levelIndex: 2,
			name: sectionName,
			path: `/statutes/cgs/section/${normalizedNumber}`,
			readableId,
			body: textBlocks.body,
			historyShort: textBlocks.historyShort,
			historyLong: textBlocks.historyLong,
			citations: textBlocks.citations,
			seeAlso: textBlocks.seeAlso,
			parentStringId: `cgs/${type}/${chapterId}`,
			sortOrder: startOffset + i,
			sourceUrl,
		});
	}

	return results;
}

/**
 * Fetch with R2 caching - streams to R2 and returns body for processing
 */
export async function fetchWithCache(
	url: string,
	versionId: string,
	storage: R2Bucket,
	fetcher?: Fetcher,
): Promise<{ body: ReadableStream<Uint8Array>; cached: boolean }> {
	const filename = extractFilename(url);
	const r2Key = `sources/cga/${versionId}/${filename}`;

	// Check cache first
	const cached = await storage.get(r2Key);
	if (cached?.body) {
		return { body: cached.body, cached: true };
	}

	// Fetch from source
	const doFetch = fetcher
		? (fetchUrl: string, init?: RequestInit) => fetcher.fetch(fetchUrl, init)
		: fetch;

	const response = await doFetch(url, {
		headers: {
			"User-Agent": "fastlaw-ingest/1.0",
			Accept: "text/html,application/xhtml+xml",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}

	if (!response.body) {
		throw new Error(`Empty response body for ${url}`);
	}

	// Read the full body - we need to both cache it and return it
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}

	// Combine chunks into single array
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}

	// Store in R2 (non-blocking-ish)
	await storage.put(r2Key, body, {
		httpMetadata: { contentType: "text/html" },
	});

	// Return a new ReadableStream from the cached data
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});

	return { body: stream, cached: false };
}

/**
 * Compute designator sort order for consistent ordering
 */
export function designatorSortOrder(value: string): number {
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return Number.MAX_SAFE_INTEGER;
	const numeric = Number.parseInt(match[1], 10);
	const suffix = match[2].toLowerCase();
	let suffixValue = 0;
	for (const char of suffix) {
		const offset = char.charCodeAt(0) - 96;
		if (offset < 1 || offset > 26) return Number.MAX_SAFE_INTEGER;
		suffixValue = suffixValue * 27 + offset;
	}
	return numeric * 100000 + suffixValue;
}

/**
 * Build section content object for blob storage
 */
export function buildSectionContent(section: ParsedSection): object {
	return {
		blocks: [
			{ type: "body", content: section.body },
			...(section.historyShort
				? [
						{
							type: "history_short",
							label: "Short History",
							content: section.historyShort,
						},
					]
				: []),
			...(section.historyLong
				? [
						{
							type: "history_long",
							label: "Long History",
							content: section.historyLong,
						},
					]
				: []),
			...(section.citations
				? [
						{
							type: "citations",
							label: "Citations",
							content: section.citations,
						},
					]
				: []),
		],
	};
}
