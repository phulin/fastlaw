import { Parser } from "htmlparser2";

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

export interface ParsedSection {
	stringId: string;
	levelName: string;
	levelIndex: number;
	name: string | null;
	path: string;
	readableId: string | null;
	body: string;
	historyShort: string | null;
	historyLong: string | null;
	citations: string | null;
	parentStringId: string | null;
	sortOrder: number;
	sourceUrl: string;
}

export interface SectionData {
	sectionId: string;
	name: string;
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
		"\xa0": " ",
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
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

/**
 * Two-pass HTML parser for chapter content
 *
 * Pass 1: Extract TOC entries (sectionId -> label) from p.toc_catchln > a[href^="#"]
 * Pass 2: Extract body content, skipping text inside span.catchln
 */
export class ChapterParser {
	private sections: SectionData[] = [];
	private currentSectionIndex = -1;
	private titleBuffer = "";
	private foundTitle = false;
	private metaDescription: string | null = null;
	private inScript = false;
	private inStyle = false;
	private inCatchln = false;
	private ignoreDepth = 0;
	private currentTarget: ContentTarget = "body";
	private targetStack: Array<{ tag: string; target: ContentTarget }> = [];

	// TOC pass state
	private tocMap: Map<string, string[]> = new Map();
	private inToc = false;
	private tocAnchorId: string | null = null;

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
		// Track title from <title> tag
		if (tag === "title" && !this.foundTitle) {
			this.titleBuffer = "";
			return;
		}

		// Track meta description
		if (tag === "meta" && attribs.name === "description") {
			this.metaDescription = attribs.content || null;
		}

		// ============ PASS 1: TOC extraction ============
		// Detect start of TOC (h4.chap_toc_hd)
		if (tag === "h4") {
			const classes = this.parseClasses(attribs.class);
			if (classes.has("chap_toc_hd")) {
				this.inToc = true;
				this.tocAnchorId = null;
			}
		}

		// In TOC: capture a[href^="#"] elements
		if (this.inToc && tag === "a" && attribs.href?.startsWith("#")) {
			const href = attribs.href;
			this.tocAnchorId = href.substring(1); // strip leading #
			return;
		}

		// End TOC after hr.chaps_pg_bar
		if (tag === "hr") {
			const classes = this.parseClasses(attribs.class);
			if (classes.has("chaps_pg_bar")) {
				this.inToc = false;
			}
		}

		// ============ PASS 2: Body extraction ============
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
				// Start new section - use ID from span or TOC map
				const sectionId = attribs.id || this.tocAnchorId || null;
				this.startSection(sectionId);
				return;
			}
		}

		if (tag === "table") {
			const classes = this.parseClasses(attribs.class);
			if (classes.has("nav_tbl")) {
				// Ignore nav_tbl content but continue parsing
				this.ignoreDepth = 1;
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
			this.addNewline(this.currentTarget);
			return;
		}

		if (tag === "td" || tag === "th") {
			const parts = this.getCurrentParts();
			if (parts[this.currentTarget].length > 0) {
				parts[this.currentTarget].push(" | ");
			}
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

		// ============ PASS 1: TOC extraction ============
		if (tag === "a" && this.tocAnchorId) {
			// TOC link closed - text content was captured by handleText
			this.tocAnchorId = null;
		}

		// ============ PASS 2: Body extraction ============
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

		if (tag === "span" && this.inCatchln) {
			this.inCatchln = false;
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
		// ============ PASS 1: TOC extraction ============
		// Capture TOC link text (must check before title capture)
		if (this.inToc && this.tocAnchorId) {
			const decoded = decodeHtmlEntities(text);
			if (decoded) {
				const existing = this.tocMap.get(this.tocAnchorId) || [];
				existing.push(decoded);
				this.tocMap.set(this.tocAnchorId, existing);
			}
			return;
		}

		// Capture title text (only if we're inside the <title> tag)
		if (this.titleBuffer !== undefined && !this.foundTitle) {
			this.titleBuffer += text;
			return;
		}

		// ============ PASS 2: Body extraction ============
		if (this.inScript || this.inStyle || this.ignoreDepth > 0) {
			return;
		}
		if (this.inCatchln) {
			// Skip text inside span.catchln - label comes from TOC
			return;
		}
		this.getCurrentParts()[this.currentTarget].push(text);
	}

	private handleComment(_comment: string): void {
		// Skip HTML comments
	}

	private startSection(sectionId: string | null): void {
		if (!sectionId) return;

		this.inCatchln = true;
		this.currentSectionIndex = this.sections.length;

		this.sections.push({
			sectionId,
			name:
				this.tocMap.get(sectionId)?.join("").replace(/\s+/g, " ").trim() || "", // Use label from TOC
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
			map.set(section.sectionId, section.name || section.sectionId);
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
 * Extract all sections from a chapter HTML file - two-pass parsing
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

	const results: ParsedSection[] = [];

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		const label = labelMap.get(section.sectionId) || section.sectionId;
		const { number, title } = parseLabel(label);

		// Fall back to full label if parseLabel returns null for title
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

		const normalizedNumber = (
			number || section.sectionId.replace(/^sec[s]?_/, "")
		).replace(/\s+/g, "_");
		const readableId = normalizedNumber.replace("_", " ");

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
			parentStringId: `cgs/chapter/${chapterId}`,
			sortOrder: i,
			sourceUrl,
		});
	}

	return results;
}

/**
 * Extract chapter title from HTML - uses the two-pass parser
 */
export function extractChapterTitle(html: string): string | null {
	const parser = new ChapterParser();
	parser.parse(html);
	return parser.getChapterTitle();
}
