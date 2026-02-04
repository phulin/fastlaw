import { Parser } from "htmlparser2";

const SECTION_BODY_TAGS = new Set(["content", "chapeau", "p"]);
const SECTION_SKIP_TAGS = new Set(["num", "heading", "sourceCredit", "notes"]);

function normalizeTagName(tagName: string): string {
	const colonIndex = tagName.indexOf(":");
	if (colonIndex !== -1) {
		return tagName.substring(colonIndex + 1);
	}
	return tagName;
}

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

export interface USCSection {
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

export type USCStreamEvent =
	| { type: "title"; titleNum: string; titleName: string }
	| { type: "level"; level: USCLevel }
	| { type: "section"; section: USCSection };

interface LevelFrame {
	levelType: USCLevelType;
	num: string | null;
	identifier: string | null;
	heading: string;
	parentIdentifier: string | null;
	emitted: boolean;
}

interface SectionFrame {
	titleNum: string;
	sectionNum: string | null;
	heading: string;
	bodyParts: string[];
	historyShort: string;
	historyLongParts: string[];
	citationsParts: Array<{ heading: string; body: string }>;
	parentLevelId: string;
}

interface NoteFrame {
	topic: string;
	role: string;
	headingText: string;
	pParts: string[];
}

function createUSCEventParser(fileTitle: string) {
	const events: USCStreamEvent[] = [];
	const tagStack: string[] = [];
	const levelStack: LevelFrame[] = [];
	const sectionCounts = new Map<string, number>();

	let docIdentifier = "";
	let titleNum = fileTitle;
	let titleName = "";
	let titleEmitted = false;

	let metaDepth = 0;
	let metaTitleCapture = false;
	let metaTitleBuffer = "";

	let headingTarget: "level" | "section" | "note" | null = null;
	let headingBuffer = "";

	let currentSection: SectionFrame | null = null;
	let skipDepth = 0;
	let bodyCaptureDepth = 0;
	let bodyBuffer = "";
	let sourceCreditDepth = 0;
	let sourceCreditBuffer = "";
	let noteDepth = 0;
	let quotedContentDepth = 0;
	let ignoredSectionDepth = 0;

	let currentNote: NoteFrame | null = null;
	let notePDepth = 0;
	let notePBuffer = "";

	const emit = (event: USCStreamEvent) => {
		events.push(event);
	};

	const ensureTitleNum = (ident?: string) => {
		const parsed = parseTitleFromIdentifier(ident);
		if (parsed) {
			titleNum = parsed;
		}
	};

	const emitTitleIfNeeded = () => {
		if (titleEmitted) return;
		if (!titleName) {
			titleName = `Title ${titleNum}`;
		}
		emit({ type: "title", titleNum, titleName });
		titleEmitted = true;
	};

	const ensureLevelIdentifier = (frame: LevelFrame) => {
		if (frame.identifier || !frame.num) return;
		frame.identifier = `${titleNum}-${LEVEL_ID_PREFIXES[frame.levelType]}${frame.num}`;
	};

	const emitLevel = (frame: LevelFrame) => {
		ensureLevelIdentifier(frame);
		if (frame.emitted || !frame.identifier || !frame.num) return;
		emit({
			type: "level",
			level: {
				levelType: frame.levelType,
				levelIndex: USC_LEVEL_INDEX[frame.levelType],
				identifier: frame.identifier,
				num: frame.num,
				heading: frame.heading,
				titleNum,
				parentIdentifier: frame.parentIdentifier,
			},
		});
		frame.emitted = true;
	};

	const emitPendingLevels = () => {
		for (const frame of levelStack) {
			if (!frame.emitted) {
				emitLevel(frame);
			}
		}
	};

	const parser = new Parser(
		{
			onopentag(name, attrs) {
				const tagName = normalizeTagName(name);
				const parentTag = tagStack[tagStack.length - 1];
				tagStack.push(tagName);

				if (!docIdentifier && typeof attrs.identifier === "string") {
					docIdentifier = attrs.identifier;
					ensureTitleNum(attrs.identifier);
				}

				if (tagName === "meta") {
					metaDepth += 1;
				}

				if (metaDepth > 0 && tagName === "title") {
					metaTitleCapture = true;
					metaTitleBuffer = "";
				}

				if (tagName === "title" && parentTag === "main") {
					if (typeof attrs.identifier === "string") {
						ensureTitleNum(attrs.identifier);
					}
					emitTitleIfNeeded();
				}

				if (tagName === "note") {
					noteDepth += 1;
				}

				if (tagName === "quotedContent") {
					quotedContentDepth += 1;
				}

				if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
					const levelType = tagName as USCLevelType;
					const ident =
						typeof attrs.identifier === "string" ? attrs.identifier : undefined;
					const levelNum = parseLevelNumFromIdentifier(ident, levelType);
					const parentIdentifier =
						levelStack.length > 0
							? levelStack[levelStack.length - 1].identifier
							: `${titleNum}-title`;

					const frame: LevelFrame = {
						levelType,
						num: levelNum,
						identifier: levelNum
							? `${titleNum}-${LEVEL_ID_PREFIXES[levelType]}${levelNum}`
							: null,
						heading: "",
						parentIdentifier,
						emitted: false,
					};
					levelStack.push(frame);
				}

				if (tagName === "section") {
					if (noteDepth > 0 || quotedContentDepth > 0) {
						ignoredSectionDepth += 1;
						return;
					}
					emitPendingLevels();
					const ident =
						typeof attrs.identifier === "string" ? attrs.identifier : undefined;
					const sectionNum = parseSectionFromIdentifier(ident);

					const parentLevel = levelStack[levelStack.length - 1];
					const parentLevelId = parentLevel?.identifier
						? `lvl_usc_${parentLevel.levelType}_${parentLevel.identifier}`
						: `lvl_usc_title_${titleNum}`;

					currentSection = {
						titleNum,
						sectionNum,
						heading: "",
						bodyParts: [],
						historyShort: "",
						historyLongParts: [],
						citationsParts: [],
						parentLevelId,
					};
					return;
				}

				if (currentSection) {
					if (SECTION_SKIP_TAGS.has(tagName)) {
						skipDepth += 1;
					}

					if (
						tagName === "num" &&
						typeof attrs.value === "string" &&
						!currentSection.sectionNum
					) {
						currentSection.sectionNum = stripLeadingZeros(attrs.value);
					}

					if (tagName === "sourceCredit") {
						sourceCreditDepth += 1;
						sourceCreditBuffer = "";
					}

					if (SECTION_BODY_TAGS.has(tagName) && skipDepth === 0) {
						bodyCaptureDepth += 1;
						if (bodyCaptureDepth === 1) {
							bodyBuffer = "";
						}
					}

					if (tagName === "note") {
						currentNote = {
							topic: typeof attrs.topic === "string" ? attrs.topic : "",
							role: typeof attrs.role === "string" ? attrs.role : "",
							headingText: "",
							pParts: [],
						};
					}

					if (currentNote && tagName === "p") {
						notePDepth += 1;
						if (notePDepth === 1) {
							notePBuffer = "";
						}
					}
				}

				if (tagName === "heading") {
					if (currentNote) {
						headingTarget = "note";
						headingBuffer = "";
					} else if (currentSection) {
						headingTarget = "section";
						headingBuffer = "";
					} else if (levelStack.length > 0) {
						headingTarget = "level";
						headingBuffer = "";
					}
				}
			},
			ontext(text) {
				if (metaTitleCapture) {
					metaTitleBuffer += text;
				}

				if (headingTarget) {
					headingBuffer += text;
				}

				if (currentSection && bodyCaptureDepth > 0 && skipDepth === 0) {
					bodyBuffer += text;
				}

				if (sourceCreditDepth > 0) {
					sourceCreditBuffer += text;
				}

				if (notePDepth > 0) {
					notePBuffer += text;
				}
			},
			onclosetag(name) {
				const tagName = normalizeTagName(name);
				tagStack.pop();

				if (tagName === "section" && ignoredSectionDepth > 0) {
					ignoredSectionDepth -= 1;
					return;
				}

				if (tagName === "meta") {
					metaDepth -= 1;
				}

				if (metaTitleCapture && tagName === "title" && metaDepth > 0) {
					const candidate = metaTitleBuffer.trim();
					if (candidate) {
						titleName = candidate;
					}
					metaTitleCapture = false;
					metaTitleBuffer = "";
				}

				if (headingTarget && tagName === "heading") {
					const heading = normalizedWhitespace(headingBuffer);
					if (headingTarget === "note" && currentNote) {
						currentNote.headingText = heading;
					}
					if (headingTarget === "section" && currentSection) {
						currentSection.heading = heading;
					}
					if (headingTarget === "level" && levelStack.length > 0) {
						const frame = levelStack[levelStack.length - 1];
						frame.heading = heading;
						emitLevel(frame);
					}
					headingTarget = null;
					headingBuffer = "";
				}

				if (currentSection && SECTION_SKIP_TAGS.has(tagName)) {
					skipDepth -= 1;
				}

				if (currentSection && SECTION_BODY_TAGS.has(tagName)) {
					bodyCaptureDepth -= 1;
					if (bodyCaptureDepth === 0) {
						const text = bodyBuffer.trim();
						if (text) {
							currentSection.bodyParts.push(text);
						}
						bodyBuffer = "";
					}
				}

				if (tagName === "sourceCredit") {
					sourceCreditDepth -= 1;
					if (sourceCreditDepth === 0 && currentSection) {
						currentSection.historyShort =
							normalizedWhitespace(sourceCreditBuffer);
						sourceCreditBuffer = "";
					}
				}

				if (currentNote && tagName === "p" && notePDepth > 0) {
					notePDepth -= 1;
					if (notePDepth === 0) {
						const text = normalizedWhitespace(notePBuffer);
						if (text) {
							currentNote.pParts.push(text);
						}
						notePBuffer = "";
					}
				}

				if (currentNote && tagName === "note") {
					const heading = currentNote.headingText;
					const body = normalizedWhitespace(currentNote.pParts.join("\n\n"));
					const finalBody = body || heading;

					if (currentSection && (finalBody || currentNote.topic)) {
						if (
							currentNote.topic === "amendments" ||
							heading.toLowerCase().includes("amendments")
						) {
							if (finalBody) {
								currentSection.historyLongParts.push(finalBody);
							}
						} else if (
							currentNote.role.includes("crossHeading") ||
							heading.includes("Editorial") ||
							heading.includes("Statutory")
						) {
						} else if (finalBody) {
							currentSection.citationsParts.push({
								heading,
								body: finalBody,
							});
						}
					}

					currentNote = null;
				}

				if (tagName === "note") {
					noteDepth -= 1;
				}

				if (tagName === "quotedContent") {
					quotedContentDepth -= 1;
				}

				if (tagName === "section" && currentSection) {
					const baseSectionNum = currentSection.sectionNum;
					if (baseSectionNum) {
						const sectionKey = `${titleNum}-${baseSectionNum}`;
						const count = sectionCounts.get(sectionKey) ?? 0;
						sectionCounts.set(sectionKey, count + 1);
						const finalSectionNum =
							count === 0 ? baseSectionNum : `${baseSectionNum}-${count + 1}`;

						const body = normalizedWhitespace(
							currentSection.bodyParts.join("\n\n"),
						);
						const historyLong = currentSection.historyLongParts.join("\n\n");
						const citations = currentSection.citationsParts
							.filter(({ body: entryBody }) => entryBody)
							.map(({ heading, body: entryBody }) =>
								heading ? `${heading}\n${entryBody}` : entryBody,
							)
							.join("\n\n")
							.trim();

						const section: USCSection = {
							titleNum,
							sectionNum: finalSectionNum,
							heading: currentSection.heading,
							body,
							historyShort: currentSection.historyShort,
							historyLong,
							citations,
							path: `/statutes/usc/section/${titleNum}/${finalSectionNum}`,
							docId: `doc_usc_${titleNum}-${finalSectionNum}`,
							levelId: `lvl_usc_section_${titleNum}-${finalSectionNum}`,
							parentLevelId: currentSection.parentLevelId,
						};

						emit({ type: "section", section });
					}
					currentSection = null;
				}

				if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
					const frame = levelStack[levelStack.length - 1];
					if (frame) {
						emitLevel(frame);
						levelStack.pop();
					}
				}
			},
		},
		{
			xmlMode: true,
			decodeEntities: true,
		},
	);

	return {
		parser,
		events,
		getTitleInfo: () => ({
			titleNum,
			titleName: titleName || `Title ${titleNum}`,
		}),
	};
}

async function* stringChunks(
	input: ReadableStream<Uint8Array> | string,
): AsyncGenerator<string, void, void> {
	if (typeof input === "string") {
		yield input;
		return;
	}

	const reader = input.getReader();
	const decoder = new TextDecoder();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			yield decoder.decode(value, { stream: true });
		}
	}
	const final = decoder.decode();
	if (final) {
		yield final;
	}
}

export async function* streamUSCXml(
	input: ReadableStream<Uint8Array> | string,
	fileTitle: string,
	_sourceUrl: string,
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	const { parser, events, getTitleInfo } = createUSCEventParser(fileTitle);

	for await (const chunk of stringChunks(input)) {
		parser.write(chunk);
		while (events.length > 0) {
			const event = events.shift();
			if (event) {
				yield event;
			}
		}
	}

	parser.end();
	while (events.length > 0) {
		const event = events.shift();
		if (event) {
			yield event;
		}
	}

	return getTitleInfo();
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
	const { parser, events, getTitleInfo } = createUSCEventParser(fileTitle);
	parser.write(xmlContent);
	parser.end();

	const sections: USCSection[] = [];
	const levels: USCLevel[] = [];

	for (const event of events) {
		if (event.type === "section") {
			sections.push(event.section);
		}
		if (event.type === "level") {
			levels.push(event.level);
		}
	}

	const { titleNum, titleName } = getTitleInfo();
	return { sections, levels, titleNum, titleName };
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
