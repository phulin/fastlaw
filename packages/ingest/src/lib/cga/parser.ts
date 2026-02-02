import { Parser } from "htmlparser2";
import type { ParsedSection } from "../../types";

// Regex patterns from Python code
const SECTION_START_RE = /<span[^>]*class="catchln"[^>]*id="([^"]+)"[^>]*>/gi;
const SECTION_LABEL_RE = /^(Secs?)\.\s+([^.]+)\.\s*(.*)$/;
const SECTION_RANGE_RE = /^(.+?)\s+to\s+([^,]+)/i;

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

/**
 * HTML parser that extracts text content classified by CSS classes.
 * Ports the Python SectionTextExtractor logic to htmlparser2.
 */
export class SectionTextExtractor {
	private parts: TextParts = {
		body: [],
		history_short: [],
		history_long: [],
		citations: [],
		see_also: [],
	};
	private currentTarget: ContentTarget = "body";
	private targetStack: Array<{ tag: string; target: ContentTarget }> = [];
	private inScript = false;
	private inStyle = false;
	private inLabel = false;
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
			},
			{ decodeEntities: true },
		);

		parser.write(html);
		parser.end();
	}

	private handleOpenTag(tag: string, attribs: Record<string, string>): void {
		if (this.stopParsing) return;
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
				this.inLabel = true;
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
				this.parts[this.currentTarget].push(" | ");
			}
			this.rowCells++;
		}

		if (SectionTextExtractor.BLOCK_TAGS.has(tag)) {
			this.addNewline(this.currentTarget);
		}
	}

	private handleCloseTag(tag: string): void {
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

		if (SectionTextExtractor.BLOCK_TAGS.has(tag)) {
			this.addNewline(this.currentTarget);
		}
	}

	private handleText(text: string): void {
		if (this.stopParsing) return;
		if (this.inScript || this.inStyle || this.ignoreDepth > 0 || this.inLabel) {
			return;
		}
		this.parts[this.currentTarget].push(text);
	}

	private addNewline(target: ContentTarget): void {
		const arr = this.parts[target];
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

	getText(target: ContentTarget): string {
		const raw = this.parts[target].join("");
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
}

/**
 * Extract section label from HTML
 */
export function extractLabel(
	sectionHtml: string,
	sectionId: string,
): string | null {
	const pattern = new RegExp(
		`<span[^>]*class="catchln"[^>]*id="${escapeRegex(sectionId)}"[^>]*>(.*?)</span>`,
		"is",
	);
	const match = sectionHtml.match(pattern);
	if (!match) return null;

	const labelHtml = match[1];
	const label = labelHtml.replace(/<[^>]+>/g, "");
	return decodeHtmlEntities(label).trim();
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

	const match = label.match(SECTION_LABEL_RE);
	if (!match) {
		return { number: null, title: null, rangeStart: null, rangeEnd: null };
	}

	const number = match[2].trim();
	const title = match[3].trim() || null;
	let rangeStart: string | null = null;
	let rangeEnd: string | null = null;

	if (match[1].toLowerCase().startsWith("secs")) {
		const rangeMatch = number.match(SECTION_RANGE_RE);
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
 * Extract text blocks from section HTML
 */
export function extractTextBlocks(sectionHtml: string): {
	body: string;
	historyShort: string;
	historyLong: string;
	citations: string;
	seeAlso: string;
} {
	const extractor = new SectionTextExtractor();
	extractor.parse(sectionHtml);

	return {
		body: trimTrailingHeadings(extractor.getText("body")),
		historyShort: extractor.getText("history_short"),
		historyLong: extractor.getText("history_long"),
		citations: extractor.getText("citations"),
		seeAlso: extractor.getText("see_also"),
	};
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

	const headingRe = /^(?:PART|SUBPART|ARTICLE|CHAPTER)\s+[IVXLC\d]+$/;
	const capsRe = /^[A-Z][A-Z\s\-,&]+$/;
	const parenHeadingRe = /^\(([A-Z]|[IVXLC]+)\)$/;

	while (lines.length > 0) {
		const line = lines[lines.length - 1].trim();

		if (headingRe.test(line)) {
			lines.pop();
			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}
			continue;
		}

		if (capsRe.test(line) && line.length <= 80) {
			lines.pop();
			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}
			continue;
		}

		if (parenHeadingRe.test(line)) {
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
 * Extract all sections from a chapter HTML file
 */
export function extractSectionsFromHtml(
	html: string,
	chapterId: string,
	sourceUrl: string,
): ParsedSection[] {
	const sections: ParsedSection[] = [];
	const matches: Array<{ index: number; id: string }> = [];

	// Reset regex
	SECTION_START_RE.lastIndex = 0;
	for (
		let match = SECTION_START_RE.exec(html);
		match !== null;
		match = SECTION_START_RE.exec(html)
	) {
		matches.push({ index: match.index, id: match[1] });
	}

	for (let i = 0; i < matches.length; i++) {
		const { index: start, id: sectionId } = matches[i];
		const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
		const sectionHtml = html.slice(start, end);

		const label = extractLabel(sectionHtml, sectionId) || sectionId;
		const { number, title, rangeStart } = parseLabel(label);
		const textBlocks = extractTextBlocks(sectionHtml);
		const titleId = extractTitleId(sectionId, number, rangeStart);

		const normalizedNumber = number || sectionId.replace(/secs?_/, "");
		const derivedTitleId = titleId || normalizedNumber.split("-")[0];

		sections.push({
			stringId: `cgs/section/${normalizedNumber}`,
			levelName: "section",
			levelIndex: 2,
			label: label,
			name: title,
			slug: `statutes/cgs/section/${derivedTitleId}/${normalizedNumber.replace(`${derivedTitleId}-`, "")}`,
			body: textBlocks.body,
			historyShort: textBlocks.historyShort || null,
			historyLong: textBlocks.historyLong || null,
			citations: textBlocks.citations || null,
			parentStringId: `cgs/chapter/${chapterId}`,
			sortOrder: i,
			sourceUrl,
		});
	}

	return sections;
}

/**
 * Extract chapter title from HTML
 */
export function extractChapterTitle(html: string): string | null {
	// Try <title> tag first
	const titleMatch = html.match(/<title>(.*?)<\/title>/is);
	if (titleMatch) {
		const title = titleMatch[1].replace(/<[^>]+>/g, "");
		const decoded = decodeHtmlEntities(title).trim();
		if (decoded) return cleanChapterTitle(decoded);
	}

	// Try meta description
	const metaMatch = html.match(
		/<meta[^>]+name="Description"[^>]+content="([^"]+)"/i,
	);
	if (metaMatch) {
		return cleanChapterTitle(decodeHtmlEntities(metaMatch[1]).trim());
	}

	return null;
}

/**
 * Clean chapter title (remove "Chapter X - " prefix)
 */
function cleanChapterTitle(title: string): string {
	return title.replace(/^Chapter\s+[^-]+-\s+/i, "").trim();
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
 * Format designator for display (proper case)
 */
export function formatDesignatorDisplay(value: string | null): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toUpperCase();
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toUpperCase();
	return `${num}${suffix}`;
}

/**
 * Format designator padded for sorting
 */
export function formatDesignatorPadded(
	value: string | null,
	width = 4,
): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const num = match[1].padStart(width, "0");
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

// Utility functions
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
