import { XMLParser } from "fast-xml-parser";

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

/**
 * Canonical organizational level hierarchy for USC.
 * These are ordered from top (title) to bottom (before section).
 * Each level has a fixed level_index regardless of which levels are present in a particular title.
 */
export const USC_LEVEL_HIERARCHY = [
	"title",
	"subtitle",
	"chapter",
	"subchapter",
	"part",
	"subpart",
	"division",
	"subdivision",
] as const;

export type USCLevelType = (typeof USC_LEVEL_HIERARCHY)[number];

/**
 * Map from level type to its canonical level_index
 */
export const USC_LEVEL_INDEX: Record<USCLevelType, number> = Object.fromEntries(
	USC_LEVEL_HIERARCHY.map((level, index) => [level, index]),
) as Record<USCLevelType, number>;

/**
 * Set of level type names for quick lookup
 */
const USC_LEVEL_SET = new Set<string>(USC_LEVEL_HIERARCHY);

/**
 * Identifier prefix patterns for each level type (from USLM spec)
 */
const LEVEL_ID_PREFIXES: Record<USCLevelType, string> = {
	title: "t",
	subtitle: "st",
	chapter: "ch",
	subchapter: "sch",
	part: "pt",
	subpart: "spt",
	division: "d",
	subdivision: "sd",
};

/**
 * Parse level number from an identifier like /us/usc/t42/ch21/sch1/s1983
 */
function parseLevelNumFromIdentifier(
	ident: string | undefined,
	levelType: USCLevelType,
): string | null {
	if (!ident) return null;
	const rest = ident.replace(/^\/us\/usc\//, "").replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	const prefix = LEVEL_ID_PREFIXES[levelType];

	for (const part of parts) {
		// Handle prefix matching carefully to avoid false matches
		// e.g., "st" for subtitle vs "sch" for subchapter
		if (part.startsWith(prefix)) {
			const numPart = part.substring(prefix.length);
			// Make sure it's not a longer prefix (e.g., "st" matching "sch")
			if (numPart && /^[0-9a-zA-Z]/.test(numPart)) {
				// Check if this might be a different prefix
				let isLongerPrefix = false;
				for (const [otherLevel, otherPrefix] of Object.entries(
					LEVEL_ID_PREFIXES,
				)) {
					if (
						otherLevel !== levelType &&
						otherPrefix.startsWith(prefix) &&
						otherPrefix.length > prefix.length &&
						part.startsWith(otherPrefix)
					) {
						isLongerPrefix = true;
						break;
					}
				}
				if (!isLongerPrefix) {
					return stripLeadingZeros(numPart);
				}
			}
		}
	}
	return null;
}

/**
 * Organizational level node (title, subtitle, chapter, subchapter, part, subpart, etc.)
 */
export interface USCLevel {
	levelType: USCLevelType;
	levelIndex: number;
	identifier: string; // e.g., "42-ch21" for chapter 21 of title 42
	num: string; // e.g., "21"
	heading: string;
	titleNum: string;
	parentIdentifier: string | null;
}

interface USCSection {
	titleNum: string;
	sectionNum: string;
	heading: string;
	body: string;
	historyShort: string;
	historyLong: string;
	citations: string;
	path: string;
	docId: string;
	levelId: string;
	parentLevelId: string;
}

/**
 * Parse a single USC XML file and extract all sections and organizational levels
 */
export function parseUSCXml(
	xmlContent: string,
	fileTitle: string,
	_sourceUrl: string,
): {
	sections: USCSection[];
	levels: USCLevel[];
	titleNum: string;
	titleName: string;
} {
	const parser = new XMLParser(parserOptions);
	const doc = parser.parse(xmlContent);

	const sections: USCSection[] = [];
	const levels: USCLevel[] = [];

	// Get document identifier to determine title number
	const docIdentifier = getDocIdentifier(doc);
	const docTitleNum = parseTitleFromIdentifier(docIdentifier) || fileTitle;

	// Get title name from metadata
	const titleName = getTitleName(doc, docTitleNum) || `Title ${docTitleNum}`;

	// Find main/title element
	const main = findElement(doc, "main");
	if (!main) return { sections, levels, titleNum: docTitleNum, titleName };

	const title = findElement(main, "title");
	if (!title) return { sections, levels, titleNum: docTitleNum, titleName };

	// Get title identifier
	const titleIdentifier = title["@_identifier"] as string | undefined;
	const parsedTitleNum = parseTitleFromIdentifier(titleIdentifier);
	const titleNum = parsedTitleNum || docTitleNum;

	// Track current parent chain as we traverse the tree
	// Maps level type to its identifier for finding the immediate parent
	const levelStack: Array<{ levelType: USCLevelType; identifier: string }> = [];

	// Track seen levels to avoid duplicates
	const seenLevels = new Set<string>();

	// Recursive function to traverse and discover levels
	function traverseElement(
		elem: Record<string, unknown>,
		tagName: string,
	): void {
		// Check if this is an organizational level
		if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
			const levelType = tagName as USCLevelType;
			const ident = elem["@_identifier"] as string | undefined;
			const levelNum =
				parseLevelNumFromIdentifier(ident, levelType) || getNumValue(elem);

			if (levelNum) {
				const identifier = `${titleNum}-${LEVEL_ID_PREFIXES[levelType]}${levelNum}`;

				if (!seenLevels.has(identifier)) {
					seenLevels.add(identifier);

					const headingEl = findElement(elem, "heading");
					const heading = headingEl
						? normalizedWhitespace(textContent(headingEl))
						: "";

					// Find parent - the most recent level in the stack
					const parentIdentifier =
						levelStack.length > 0
							? levelStack[levelStack.length - 1].identifier
							: `${titleNum}-title`;

					levels.push({
						levelType,
						levelIndex: USC_LEVEL_INDEX[levelType],
						identifier,
						num: levelNum,
						heading,
						titleNum,
						parentIdentifier,
					});
				}

				// Push onto stack before processing children
				levelStack.push({ levelType, identifier });
			}
		}

		// Check if this is a section
		if (tagName === "section") {
			const ident = elem["@_identifier"] as string | undefined;
			if (ident?.startsWith("/us/usc/") && ident.includes("/s")) {
				const sectionNum =
					parseSectionFromIdentifier(ident) || getNumValue(elem);
				if (sectionNum) {
					const headingEl = findElement(elem, "heading");
					const heading = headingEl
						? normalizedWhitespace(textContent(headingEl))
						: "";

					const body = extractSectionBody(elem);
					const historyShort = extractSourceCredit(elem);
					const { historyLong, citations } = extractNotes(elem);

					const path = `/statutes/usc/section/${titleNum}/${sectionNum}`;
					const docId = `doc_usc_${titleNum}-${sectionNum}`;
					const levelId = `lvl_usc_section_${titleNum}-${sectionNum}`;

					// Find parent level - use the most recent level from the stack
					const parentLevelId =
						levelStack.length > 0
							? `lvl_usc_${levelStack[levelStack.length - 1].levelType}_${levelStack[levelStack.length - 1].identifier}`
							: `lvl_usc_title_${titleNum}`;

					sections.push({
						titleNum,
						sectionNum,
						heading,
						body,
						historyShort,
						historyLong,
						citations,
						path,
						docId,
						levelId,
						parentLevelId,
					});
				}
			}
			return; // Don't recurse into sections
		}

		// Recurse into children
		for (const [key, value] of Object.entries(elem)) {
			if (key.startsWith("@_") || key === "#text") continue;

			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "object" && item !== null) {
						traverseElement(item as Record<string, unknown>, key);
					}
				}
			} else if (typeof value === "object" && value !== null) {
				traverseElement(value as Record<string, unknown>, key);
			}
		}

		// Pop from stack if we pushed for this level
		if (
			USC_LEVEL_SET.has(tagName) &&
			tagName !== "title" &&
			levelStack.length > 0
		) {
			const levelType = tagName as USCLevelType;
			const ident = elem["@_identifier"] as string | undefined;
			const levelNum =
				parseLevelNumFromIdentifier(ident, levelType) || getNumValue(elem);
			if (levelNum) {
				const identifier = `${titleNum}-${LEVEL_ID_PREFIXES[levelType]}${levelNum}`;
				// Only pop if the top of stack matches
				if (
					levelStack.length > 0 &&
					levelStack[levelStack.length - 1].identifier === identifier
				) {
					levelStack.pop();
				}
			}
		}
	}

	// Start traversal from title element
	for (const [key, value] of Object.entries(title)) {
		if (key.startsWith("@_") || key === "#text") continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "object" && item !== null) {
					traverseElement(item as Record<string, unknown>, key);
				}
			}
		} else if (typeof value === "object" && value !== null) {
			traverseElement(value as Record<string, unknown>, key);
		}
	}

	return { sections, levels, titleNum, titleName };
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

/**
 * Strip leading zeros from a numeric string with optional letter suffix (e.g., "01" -> "1", "01a" -> "1a")
 */
function stripLeadingZeros(value: string): string {
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value;
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

function parseTitleFromIdentifier(ident: string | undefined): string | null {
	if (!ident || !ident.startsWith("/us/usc/")) return null;
	const rest = ident.substring("/us/usc/".length).replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	for (const part of parts) {
		if (part.startsWith("t")) {
			return stripLeadingZeros(part.substring(1));
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
			return stripLeadingZeros(part.substring(1));
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
 * Sort key for level identifiers (title-prefixNum format, e.g., "42-ch21")
 * Sorts by: title number, then level index, then level number
 */
export function levelSortKey(
	level: USCLevel,
): [
	[number, [number, string] | string],
	number,
	[number, [number, string] | string],
] {
	return [
		titleSortKey(level.titleNum),
		level.levelIndex,
		sectionSortKey(level.num),
	];
}
