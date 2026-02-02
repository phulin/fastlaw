import { Parser } from "htmlparser2";
import type { ParsedSection } from "../../types";

const BASE_URL = "https://www.cga.ct.gov";
const ALLOWED_PREFIX = "/current/pub/";

type ContentTarget =
	| "body"
	| "history_short"
	| "history_long"
	| "citations"
	| "see_also";

interface TextParts {
	body: string[];
	history_short: string[];
	history_long: string[];
	citations: string[];
	see_also: string[];
}

export interface SectionData {
	sectionId: string;
	label: string;
	parts: TextParts;
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
	const entities: Record<string, string> = {
		"&": "&",
		"<": "<",
		">": ">",
		'"': '"',
		"'": "'",
		"&apos;": "'",
		" ": " ",
	};
	return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Format designator with zero-padding for sorting
 */
export function formatDesignatorPadded(
	value: string | null,
	width = 4,
): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const number = match[1].padStart(width, "0");
	const suffix = match[2].toLowerCase();
	return `${number}${suffix}`;
}

/**
 * Format designator for display (lowercase, no leading zeros)
 */
export function formatDesignatorDisplay(value: string | null): string | null {
	if (!value) return value;
	return value.toLowerCase();
}

/**
 * Single-pass HTML parser that extracts all section data, chapter title, and labels
 */
export class ChapterParser {
	private currentTarget: ContentTarget = "body";
	private targetStack: Array<{ tag: string; target: ContentTarget }> = [];
	private inScript = false;
	private inStyle = false;
	private inLabel = false;
	private labelBuffer = "";
	private currentSectionId: string | null = null;

	// Section tracking
	private sections: SectionData[] = [];
	private currentSectionIndex = -1;

	// Chapter title tracking
	private titleBuffer = "";
	private foundTitle = false;
	private metaDescription: string | null = null;

	// Parsing state
	private ignoreDepth = 0;
	private stopParsing = false;
	private inRow = false;
	private rowCells = 0;

	private static BLOCK_TAGS = new Set([
		"p",
		"div",
		"table",
		"tr",
		"ul",
		"ol",
		"li",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
	]);

	parse(html: string): void {
		const parser = new Parser(
			{
				onopentag: (name, attribs) => this.handleOpenTag(name, attribs),
				onclosetag: (name) => this.handleCloseTag(name),
				ontext: (text) => this.handleText(text),
				oncomment: (comment) => this.handleComment(comment),
			},
			{ decodeEntities: true },
		);

		parser.write(html);
		parser.end();
	}

	private handleOpenTag(tag: string, attribs: Record<string, string>): void {
		if (this.stopParsing) return;

		// Track title from <title> tag
		if (tag === "title" && !this.foundTitle) {
			this.titleBuffer = "";
			return;
		}

		// Track meta description
		if (tag === "meta" && attribs.name === "description") {
			this.metaDescription = attribs.content || null;
		}

		if (this.ignoreDepth > 0) {
			this.ignoreDepth++;
			return;
		}

		if (tag === "script") {
			this.inScript = true;
			return;
		}
		if (tag === "style") {
			this.inStyle = true;
			return;
		}

		if (tag === "span") {
			const classes = this.parseClasses(attribs.class);
			if (classes.has("catchln")) {
				// Start new section
				this.startSection(attribs.id || null);
				return;
			}
		}

		if (tag === "table") {
			const classes = this.parseClasses(attribs.class);
			if (classes.has("nav_tbl")) {
				this.ignoreDepth = 1;
				this.stopParsing = true;
				return;
			}
		}

		if (tag === "br" || tag === "hr") {
			this.addNewline(this.currentTarget);
			return;
		}

		const newTarget = this.classifyTarget(attribs);
		if (newTarget && newTarget !== this.currentTarget) {
			this.targetStack.push({ tag, target: this.currentTarget });
			this.currentTarget = newTarget;
		}

		if (tag === "tr") {
			this.inRow = true;
			this.rowCells = 0;
		}

		if ((tag === "td" || tag === "th") && this.inRow) {
			if (this.rowCells > 0) {
				this.getCurrentParts()[this.currentTarget].push(" | ");
			}
			this.rowCells++;
		}

		if (ChapterParser.BLOCK_TAGS.has(tag)) {
			this.addNewline(this.currentTarget);
		}
	}

	private handleCloseTag(tag: string): void {
		// Capture title text
		if (tag === "title" && this.titleBuffer && !this.foundTitle) {
			this.foundTitle = true;
		}

		if (this.stopParsing) return;
		if (this.ignoreDepth > 0) {
			this.ignoreDepth--;
			return;
		}

		if (tag === "script") {
			this.inScript = false;
			return;
		}
		if (tag === "style") {
			this.inStyle = false;
			return;
		}

		if (tag === "span" && this.inLabel) {
			this.inLabel = false;
			const label = decodeHtmlEntities(this.labelBuffer).trim();
			if (this.currentSectionId && label) {
				const section = this.sections.find(
					(s) => s.sectionId === this.currentSectionId,
				);
				if (section) {
					section.label = label;
				}
			}
			this.currentSectionId = null;
			this.labelBuffer = "";
			return;
		}

		if (tag === "tr") {
			this.inRow = false;
			this.addNewline(this.currentTarget);
			return;
		}

		if (
			this.targetStack.length > 0 &&
			this.targetStack[this.targetStack.length - 1].tag === tag
		) {
			const prev = this.targetStack.pop();
			if (prev) {
				this.currentTarget = prev.target;
			}
		}

		if (ChapterParser.BLOCK_TAGS.has(tag)) {
			this.addNewline(this.currentTarget);
		}
	}

	private handleText(text: string): void {
		if (this.stopParsing) return;

		// Capture title text
		if (this.titleBuffer !== undefined && !this.foundTitle) {
			this.titleBuffer += text;
			return;
		}

		if (this.inScript || this.inStyle || this.ignoreDepth > 0) {
			return;
		}
		if (this.inLabel) {
			this.labelBuffer += text;
			return;
		}
		this.getCurrentParts()[this.currentTarget].push(text);
	}

	private handleComment(_comment: string): void {
		// Skip HTML comments
	}

	private startSection(sectionId: string | null): void {
		if (!sectionId) return;

		// Finish previous section's label if it was captured during parse
		if (this.currentSectionId && this.labelBuffer) {
			const prevSection = this.sections.find(
				(s) => s.sectionId === this.currentSectionId,
			);
			if (prevSection && !prevSection.label) {
				prevSection.label = decodeHtmlEntities(this.labelBuffer).trim();
			}
		}

		this.currentSectionId = sectionId;
		this.inLabel = true;
		this.labelBuffer = "";
		this.currentSectionIndex = this.sections.length;

		this.sections.push({
			sectionId,
			label: "",
			parts: {
				body: [],
				history_short: [],
				history_long: [],
				citations: [],
				see_also: [],
			},
		});
	}

	private getCurrentParts(): TextParts {
		if (this.currentSectionIndex >= 0) {
			return this.sections[this.currentSectionIndex].parts;
		}
		// Return a dummy object if no section is active (shouldn't happen)
		return {
			body: [],
			history_short: [],
			history_long: [],
			citations: [],
			see_also: [],
		};
	}

	private addNewline(target: ContentTarget): void {
		const parts = this.getCurrentParts();
		const arr = parts[target];
		if (arr.length === 0) {
			arr.push("\n");
			return;
		}
		if (!arr[arr.length - 1].endsWith("\n")) {
			arr.push("\n");
		}
	}

	private parseClasses(classAttr: string | undefined): Set<string> {
		if (!classAttr) return new Set();
		return new Set(
			classAttr
				.split(/\s+/)
				.map((c) => c.trim())
				.filter(Boolean),
		);
	}

	private classifyTarget(
		attribs: Record<string, string>,
	): ContentTarget | null {
		const classes = this.parseClasses(attribs.class);

		if (classes.has("source") || classes.has("source-first")) {
			return "history_short";
		}
		if (classes.has("history") || classes.has("history-first")) {
			return "history_long";
		}
		if (classes.has("annotation") || classes.has("annotation-first")) {
			return "citations";
		}
		if (classes.has("cross-ref") || classes.has("cross-ref-first")) {
			return "see_also";
		}
		return null;
	}

	getSections(): SectionData[] {
		return this.sections;
	}

	getChapterTitle(): string | null {
		if (this.titleBuffer) {
			const title = this.titleBuffer.replace(/<[^>]+>/g, "");
			const decoded = decodeHtmlEntities(title).trim();
			if (decoded) {
				return decoded.replace(/^Chapter\s+[^-]+-\s+/i, "").trim();
			}
		}
		if (this.metaDescription) {
			return decodeHtmlEntities(this.metaDescription)
				.replace(/^Chapter\s+[^-]+-\s+/i, "")
				.trim();
		}
		return null;
	}

	getSectionLabels(): Map<string, string> {
		const map = new Map<string, string>();
		for (const section of this.sections) {
			map.set(section.sectionId, section.label || section.sectionId);
		}
		return map;
	}
}

/**
 * Format text parts into cleaned text
 */
export function formatText(parts: string[]): string {
	const raw = parts.join("");
	const lines: string[] = [];

	for (const line of raw.split("\n")) {
		const cleaned = line.split(/\s+/).join(" ").trim();
		lines.push(cleaned);
	}

	// Normalize blank lines
	const normalized: string[] = [];
	let blank = false;
	for (const line of lines) {
		if (line === "") {
			if (!blank) {
				normalized.push("");
			}
			blank = true;
		} else {
			normalized.push(line);
			blank = false;
		}
	}

	return normalized.join("\n").trim();
}

// ============ Link Extraction ============

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
export function normalizeLink(href: string, baseUrl: string): string | null {
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

/**
 * Parse section label into components
 */
export function parseLabel(label: string | null): {
	number: string | null;
	title: string | null;
	rangeStart: string | null;
	rangeEnd: string | null;
} {
	if (!label) {
		return { number: null, title: null, rangeStart: null, rangeEnd: null };
	}

	// Parse "Sec. X." or "Secs. X to Y." format
	const match = label.match(/^(Secs?)\.\s+([^.]+)\.\s*(.*)$/);
	if (!match) {
		return { number: null, title: null, rangeStart: null, rangeEnd: null };
	}

	const number = match[2].trim();
	const title = match[3].trim() || null;
	let rangeStart: string | null = null;
	let rangeEnd: string | null = null;

	if (match[1].toLowerCase().startsWith("secs")) {
		const rangeMatch = number.match(/^(.+?)\s+to\s+([^,]+)$/i);
		if (rangeMatch) {
			rangeStart = rangeMatch[1].trim();
			rangeEnd = rangeMatch[2].trim();
		}
	} else {
		rangeStart = number;
		rangeEnd = number;
	}

	return { number, title, rangeStart, rangeEnd };
}

/**
 * Extract title ID from section ID or number
 */
export function extractTitleId(
	sectionId: string,
	sectionNumber: string | null,
	rangeStart: string | null,
): string | null {
	const candidate = rangeStart || sectionNumber;
	if (!candidate) return null;

	if (!candidate.includes("-")) {
		const cleanedId = sectionId.replace(/secs?_/g, "");
		if (cleanedId.includes("-")) {
			return cleanedId.split("-")[0].trim();
		}
		return candidate.trim();
	}
	return candidate.split("-")[0].trim();
}

/**
 * Normalize designator (strip leading zeros, lowercase)
 */
export function normalizeDesignator(value: string | null): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

/**
 * Extract all sections from a chapter HTML file - single pass parsing
 */
export function extractSectionsFromHtml(
	html: string,
	chapterId: string,
	sourceUrl: string,
): ParsedSection[] {
	const parser = new ChapterParser();
	parser.parse(html);

	const sections = parser.getSections();
	const labelMap = parser.getSectionLabels();
	const _chapterTitle = parser.getChapterTitle();

	const results: ParsedSection[] = [];

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		const label = labelMap.get(section.sectionId) || section.sectionId;
		const { number, title, rangeStart } = parseLabel(label);

		const textBlocks = {
			body: trimTrailingHeadings(formatText(section.parts.body)),
			historyShort: formatText(section.parts.history_short) || null,
			historyLong: formatText(section.parts.history_long) || null,
			citations: formatText(section.parts.citations) || null,
			seeAlso: formatText(section.parts.see_also) || null,
		};

		const titleId = extractTitleId(section.sectionId, number, rangeStart);
		const normalizedNumber = number || section.sectionId.replace(/secs?_/, "");
		const derivedTitleId = titleId || normalizedNumber.split("-")[0];

		results.push({
			stringId: `cgs/section/${normalizedNumber}`,
			levelName: "section",
			levelIndex: 2,
			label: label,
			name: title,
			slug: `statutes/cgs/section/${derivedTitleId}/${normalizedNumber.replace(`${derivedTitleId}-`, "")}`,
			body: textBlocks.body,
			historyShort: textBlocks.historyShort,
			historyLong: textBlocks.historyLong,
			citations: textBlocks.citations,
			parentStringId: `cgs/chapter/${chapterId}`,
			sortOrder: i,
			sourceUrl,
		});
	}

	return results;
}

/**
 * Extract chapter title from HTML - uses the single-pass parser
 */
export function extractChapterTitle(html: string): string | null {
	const parser = new ChapterParser();
	parser.parse(html);
	return parser.getChapterTitle();
}
