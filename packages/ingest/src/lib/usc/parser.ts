import { XMLParser } from "fast-xml-parser";

const _USLM_NS = "http://xml.house.gov/schemas/uslm/1.0";
const _DC_NS = "http://purl.org/dc/elements/1.1/";

// fast-xml-parser configuration for handling namespaces
const parserOptions = {
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	parseTagValue: false,
	trimValues: true,
	// Handle namespaces by removing prefixes
	transformTagName: (tagName: string) => {
		// Remove namespace prefix if present
		const colonIndex = tagName.indexOf(":");
		if (colonIndex !== -1) {
			return tagName.substring(colonIndex + 1);
		}
		return tagName;
	},
};

interface USCSection {
	titleNum: string;
	chapterId: string | null;
	chapterHeading: string | null;
	sectionNum: string;
	heading: string;
	body: string;
	historyShort: string;
	historyLong: string;
	citations: string;
	slug: string;
	docId: string;
	levelId: string;
	parentLevelId: string;
}

/**
 * Parse a single USC XML file and extract all sections
 */
export function parseUSCXml(
	xmlContent: string,
	fileTitle: string,
	_sourceUrl: string,
): {
	sections: USCSection[];
	titles: Map<string, string>;
	chapters: Map<string, { titleNum: string; heading: string }>;
} {
	const parser = new XMLParser(parserOptions);
	const doc = parser.parse(xmlContent);

	const sections: USCSection[] = [];
	const titles = new Map<string, string>();
	const chapters = new Map<string, { titleNum: string; heading: string }>();

	// Get document identifier to determine title number
	const docIdentifier = getDocIdentifier(doc);
	const docTitleNum = parseTitleFromIdentifier(docIdentifier) || fileTitle;

	// Get title name from metadata
	const titleName = getTitleName(doc, docTitleNum);
	if (titleName) {
		titles.set(docTitleNum, titleName);
	}

	// Find main/title element
	const main = findElement(doc, "main");
	if (!main) return { sections, titles, chapters };

	const title = findElement(main, "title");
	if (!title) return { sections, titles, chapters };

	// Get title identifier
	const titleIdentifier = title["@_identifier"] as string | undefined;
	const parsedTitleNum = parseTitleFromIdentifier(titleIdentifier);
	const titleNum = parsedTitleNum || docTitleNum;

	// Iterate through elements to find chapters and sections
	let currentChapterId: string | null = null;
	let currentChapterHeading: string | null = null;

	iterateElements(title, (elem, tagName) => {
		if (tagName === "chapter") {
			const chapterIdent = elem["@_identifier"] as string | undefined;
			const chapterNum = parseChapterFromIdentifier(chapterIdent);
			currentChapterId = chapterNum ? `${titleNum}-${chapterNum}` : null;

			const headingEl = findElement(elem, "heading");
			currentChapterHeading = headingEl ? textContent(headingEl) : null;

			if (currentChapterId && currentChapterHeading) {
				chapters.set(currentChapterId, {
					titleNum,
					heading: currentChapterHeading,
				});
			}
		} else if (tagName === "section") {
			const ident = elem["@_identifier"] as string | undefined;
			if (!ident || !ident.startsWith("/us/usc/") || !ident.includes("/s")) {
				return;
			}

			const sectionNum = parseSectionFromIdentifier(ident) || getNumValue(elem);
			if (!sectionNum) return;

			const headingEl = findElement(elem, "heading");
			const heading = headingEl
				? normalizedWhitespace(textContent(headingEl))
				: "";

			const body = extractSectionBody(elem);
			const historyShort = extractSourceCredit(elem);
			const { historyLong, citations } = extractNotes(elem);

			const slug = `statutes/usc/section/${titleNum}/${sectionNum}`;
			const docId = `doc_usc_${titleNum}-${sectionNum}`;
			const levelId = `lvl_usc_section_${titleNum}-${sectionNum}`;
			const parentLevelId = currentChapterId
				? `lvl_usc_chapter_${currentChapterId}`
				: `lvl_usc_title_${titleNum}`;

			sections.push({
				titleNum,
				chapterId: currentChapterId,
				chapterHeading: currentChapterHeading,
				sectionNum,
				heading,
				body,
				historyShort,
				historyLong,
				citations,
				slug,
				docId,
				levelId,
				parentLevelId,
			});
		}
	});

	return { sections, titles, chapters };
}

/**
 * Extract body content from a section element
 */
function extractSectionBody(sectionEl: Record<string, unknown>): string {
	const bodyTags = new Set([
		"content",
		"chapeau",
		"subsection",
		"paragraph",
		"subparagraph",
		"clause",
		"p",
	]);
	const skipTags = new Set(["num", "heading", "sourceCredit", "notes"]);

	const parts: string[] = [];

	function extractRecursive(el: Record<string, unknown>): string[] {
		const collected: string[] = [];

		for (const [key, value] of Object.entries(el)) {
			if (key.startsWith("@_") || key === "#text") continue;

			if (skipTags.has(key)) continue;

			if (bodyTags.has(key)) {
				if (key === "content" || key === "chapeau" || key === "p") {
					const txt = textContent(value);
					if (txt) collected.push(txt);
				} else {
					// For structural elements, recurse
					if (Array.isArray(value)) {
						for (const item of value) {
							if (typeof item === "object" && item !== null) {
								collected.push(
									...extractRecursive(item as Record<string, unknown>),
								);
							}
						}
					} else if (typeof value === "object" && value !== null) {
						collected.push(
							...extractRecursive(value as Record<string, unknown>),
						);
					}
				}
			}
		}

		return collected;
	}

	for (const [key, value] of Object.entries(sectionEl)) {
		if (key.startsWith("@_") || key === "#text") continue;
		if (skipTags.has(key)) continue;

		if (bodyTags.has(key)) {
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "object" && item !== null) {
						parts.push(...extractRecursive(item as Record<string, unknown>));
					}
				}
			} else if (typeof value === "object" && value !== null) {
				parts.push(...extractRecursive(value as Record<string, unknown>));
			}
		}
	}

	return normalizedWhitespace(parts.join("\n\n"));
}

/**
 * Extract sourceCredit as history
 */
function extractSourceCredit(sectionEl: Record<string, unknown>): string {
	const sourceCredit = findElement(sectionEl, "sourceCredit");
	if (!sourceCredit) return "";
	return normalizedWhitespace(allTextContent(sourceCredit));
}

/**
 * Extract notes (amendments -> historyLong, other -> citations)
 */
function extractNotes(sectionEl: Record<string, unknown>): {
	historyLong: string;
	citations: string;
} {
	const notesEl = findElement(sectionEl, "notes");
	if (!notesEl) return { historyLong: "", citations: "" };

	const amendments: string[] = [];
	const statutory: Array<{ heading: string; body: string }> = [];

	// Find all note elements
	const notes = findAllElements(notesEl, "note");
	for (const note of notes) {
		const topic = (note["@_topic"] as string) || "";
		const role = (note["@_role"] as string) || "";

		const headingEl = findElement(note, "heading");
		const heading = headingEl ? textContent(headingEl) : "";

		// Collect all p elements
		const pElements = findAllElements(note, "p");
		const bodyParts = pElements.map((p) => textContent(p));
		const body = normalizedWhitespace(bodyParts.join("\n\n"));

		const finalBody = body || heading;

		if (topic === "amendments" || heading.includes("amendments")) {
			if (finalBody) amendments.push(finalBody);
		} else if (
			role.includes("crossHeading") ||
			heading.includes("Editorial") ||
			heading.includes("Statutory")
		) {
		} else if (topic || finalBody) {
			statutory.push({ heading, body: finalBody });
		}
	}

	const historyLong = amendments.join("\n\n");
	const citations = statutory
		.filter(({ body }) => body)
		.map(({ heading, body }) => (heading ? `${heading}\n${body}` : body))
		.join("\n\n")
		.trim();

	return { historyLong, citations };
}

// Helper functions

function getDocIdentifier(doc: Record<string, unknown>): string {
	// Try to find document root with identifier
	for (const [_key, value] of Object.entries(doc)) {
		if (typeof value === "object" && value !== null) {
			const identifier = (value as Record<string, unknown>)["@_identifier"];
			if (typeof identifier === "string") {
				return identifier;
			}
		}
	}
	return "";
}

function getTitleName(
	doc: Record<string, unknown>,
	titleNum: string,
): string | null {
	// Try to find dc:title in meta
	const meta = findElementDeep(doc, "meta");
	if (meta) {
		for (const [key, value] of Object.entries(meta)) {
			if (key === "title" || key.endsWith(":title")) {
				const txt = typeof value === "string" ? value : textContent(value);
				if (txt) return txt.trim();
			}
		}
	}
	return `Title ${titleNum}`;
}

function parseTitleFromIdentifier(ident: string | undefined): string | null {
	if (!ident || !ident.startsWith("/us/usc/")) return null;
	const rest = ident.substring("/us/usc/".length).replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	for (const part of parts) {
		if (part.startsWith("t")) {
			return part.substring(1);
		}
	}
	return null;
}

function parseChapterFromIdentifier(ident: string | undefined): string | null {
	if (!ident) return null;
	const rest = ident.replace(/^\/us\/usc\//, "").replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	for (const part of parts) {
		if (part.startsWith("ch")) {
			return part.substring(2);
		}
	}
	return null;
}

function parseSectionFromIdentifier(ident: string | undefined): string | null {
	if (!ident) return null;
	const rest = ident.replace(/^\/us\/usc\//, "").replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	for (const part of parts) {
		if (part.startsWith("s")) {
			return part.substring(1);
		}
	}
	return null;
}

function getNumValue(elem: Record<string, unknown>): string {
	const numEl = findElement(elem, "num");
	if (!numEl) return "";
	const value = (numEl as Record<string, unknown>)["@_value"];
	return typeof value === "string" ? value : "";
}

function findElement(
	obj: unknown,
	tagName: string,
): Record<string, unknown> | null {
	if (!obj || typeof obj !== "object") return null;

	const record = obj as Record<string, unknown>;

	if (tagName in record) {
		const val = record[tagName];
		if (Array.isArray(val)) {
			return typeof val[0] === "object"
				? (val[0] as Record<string, unknown>)
				: null;
		}
		return typeof val === "object" ? (val as Record<string, unknown>) : null;
	}

	return null;
}

function findElementDeep(
	obj: unknown,
	tagName: string,
): Record<string, unknown> | null {
	if (!obj || typeof obj !== "object") return null;

	const record = obj as Record<string, unknown>;

	if (tagName in record) {
		const val = record[tagName];
		if (Array.isArray(val)) {
			return typeof val[0] === "object"
				? (val[0] as Record<string, unknown>)
				: null;
		}
		return typeof val === "object" ? (val as Record<string, unknown>) : null;
	}

	for (const value of Object.values(record)) {
		if (typeof value === "object" && value !== null) {
			const found = findElementDeep(value, tagName);
			if (found) return found;
		}
	}

	return null;
}

function findAllElements(
	obj: unknown,
	tagName: string,
): Array<Record<string, unknown>> {
	if (!obj || typeof obj !== "object") return [];

	const record = obj as Record<string, unknown>;
	const results: Array<Record<string, unknown>> = [];

	if (tagName in record) {
		const val = record[tagName];
		if (Array.isArray(val)) {
			for (const item of val) {
				if (typeof item === "object" && item !== null) {
					results.push(item as Record<string, unknown>);
				}
			}
		} else if (typeof val === "object" && val !== null) {
			results.push(val as Record<string, unknown>);
		}
	}

	return results;
}

function iterateElements(
	obj: unknown,
	callback: (elem: Record<string, unknown>, tagName: string) => void,
): void {
	if (!obj || typeof obj !== "object") return;

	const record = obj as Record<string, unknown>;

	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("@_") || key === "#text") continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "object" && item !== null) {
					callback(item as Record<string, unknown>, key);
					iterateElements(item, callback);
				}
			}
		} else if (typeof value === "object" && value !== null) {
			callback(value as Record<string, unknown>, key);
			iterateElements(value, callback);
		}
	}
}

function textContent(obj: unknown): string {
	if (!obj) return "";
	if (typeof obj === "string") return obj;
	if (typeof obj !== "object") return String(obj);

	const record = obj as Record<string, unknown>;
	const parts: string[] = [];

	// Get direct text
	if ("#text" in record) {
		const txt = record["#text"];
		if (typeof txt === "string") parts.push(txt);
	}

	// Recurse into children (excluding footnoteRef and note)
	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("@_") || key === "#text") continue;
		if (key === "footnoteRef" || key === "note") continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(textContent(item));
			}
		} else {
			parts.push(textContent(value));
		}
	}

	return parts.join("").trim();
}

function allTextContent(obj: unknown): string {
	if (!obj) return "";
	if (typeof obj === "string") return obj;
	if (typeof obj !== "object") return String(obj);

	const record = obj as Record<string, unknown>;
	const parts: string[] = [];

	if ("#text" in record) {
		const txt = record["#text"];
		if (typeof txt === "string") parts.push(txt);
	}

	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("@_") || key === "#text") continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(allTextContent(item));
			}
		} else {
			parts.push(allTextContent(value));
		}
	}

	return parts.join("").trim();
}

function normalizedWhitespace(s: string): string {
	if (!s) return "";
	return s
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line)
		.join("\n\n")
		.trim();
}

/**
 * Sort key for section numbers (1, 2, 10, 101, 7a)
 */
export function sectionSortKey(
	sectionNum: string,
): [number, [number, string] | string] {
	const m = sectionNum.toLowerCase().match(/^(\d+)([a-z]*)$/);
	if (!m) {
		return [0, sectionNum.toLowerCase()];
	}
	return [1, [Number.parseInt(m[1], 10), m[2]]];
}

/**
 * Sort key for title numbers
 */
export function titleSortKey(t: string): [number, [number, string] | string] {
	return sectionSortKey(t);
}

/**
 * Sort key for chapter IDs (title-chapter format)
 */
export function chapterSortKey(
	chapterId: string,
): [[number, [number, string] | string], [number, [number, string] | string]] {
	const parts = chapterId.split("-", 2);
	if (parts.length !== 2) {
		return [
			[0, chapterId],
			[0, ""],
		];
	}
	return [titleSortKey(parts[0]), sectionSortKey(parts[1])];
}
