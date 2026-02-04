import {
	type ExtractedAttribute,
	type ExtractedTag,
	type ExtractedText,
	parseXmlStreamWithHandler,
	parseXmlWithHandler,
	type SaxEvent,
} from "../sax-parser";

const SECTION_BODY_TAGS = new Set([
	"content",
	"chapeau",
	"p",
	"subsection",
	"paragraph",
	"subparagraph",
	"clause",
	"subclause",
	"item",
	"subitem",
]);
const SECTION_SKIP_TAGS = new Set(["sourceCredit", "notes"]);

function normalizeTagName(tagName: string): string {
	const colonIndex = tagName.indexOf(":");
	if (colonIndex !== -1) {
		return tagName.substring(colonIndex + 1);
	}
	return tagName;
}

/**
 * Get attribute value from extracted tag attributes
 */
function getAttr(
	attrs: ExtractedAttribute[],
	name: string,
): string | undefined {
	const attr = attrs.find((a) => a.name === name);
	return attr?.value;
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
	bracketedNum: boolean;
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
	bracketedNum: boolean;
}

interface NoteFrame {
	topic: string;
	role: string;
	headingText: string;
	pParts: string[];
}

interface ParserState {
	events: USCStreamEvent[];
	tagStack: string[];
	levelStack: LevelFrame[];
	sectionCounts: Map<string, number>;
	pendingAttrs: ExtractedAttribute[];

	docIdentifier: string;
	titleNum: string;
	titleName: string;
	titleEmitted: boolean;

	metaDepth: number;
	metaTitleCapture: boolean;
	metaTitleBuffer: string;

	headingTarget: "level" | "section" | "note" | null;
	headingBuffer: string;
	numDepth: number;
	numBuffer: string;
	numTarget: "level" | "section" | null;

	currentSection: SectionFrame | null;
	skipDepth: number;
	bodyCaptureDepth: number;
	bodyBuffer: string;
	sourceCreditDepth: number;
	sourceCreditBuffer: string;
	noteDepth: number;
	quotedContentDepth: number;
	ignoredSectionDepth: number;

	currentNote: NoteFrame | null;
	notePDepth: number;
	notePBuffer: string;

	bodyHeadingDepth: number;
	bodyHeadingBuffer: string;
}

function createParserState(fileTitle: string): ParserState {
	return {
		events: [],
		tagStack: [],
		levelStack: [],
		sectionCounts: new Map(),
		pendingAttrs: [],

		docIdentifier: "",
		titleNum: fileTitle,
		titleName: "",
		titleEmitted: false,

		metaDepth: 0,
		metaTitleCapture: false,
		metaTitleBuffer: "",

		headingTarget: null,
		headingBuffer: "",
		numDepth: 0,
		numBuffer: "",
		numTarget: null,

		currentSection: null,
		skipDepth: 0,
		bodyCaptureDepth: 0,
		bodyBuffer: "",
		sourceCreditDepth: 0,
		sourceCreditBuffer: "",
		noteDepth: 0,
		quotedContentDepth: 0,
		ignoredSectionDepth: 0,

		currentNote: null,
		notePDepth: 0,
		notePBuffer: "",

		bodyHeadingDepth: 0,
		bodyHeadingBuffer: "",
	};
}

function emit(state: ParserState, event: USCStreamEvent) {
	state.events.push(event);
}

function ensureTitleNum(state: ParserState, ident?: string) {
	const parsed = parseTitleFromIdentifier(ident);
	if (parsed) {
		state.titleNum = parsed;
	}
}

function emitTitleIfNeeded(state: ParserState) {
	if (state.titleEmitted) return;
	if (!state.titleName) {
		state.titleName = `Title ${state.titleNum}`;
	}
	emit(state, {
		type: "title",
		titleNum: state.titleNum,
		titleName: state.titleName,
	});
	state.titleEmitted = true;
}

function ensureLevelIdentifier(state: ParserState, frame: LevelFrame) {
	if (frame.identifier || !frame.num) return;
	frame.identifier = `${state.titleNum}-${LEVEL_ID_PREFIXES[frame.levelType]}${frame.num}`;
}

function emitLevel(state: ParserState, frame: LevelFrame) {
	ensureLevelIdentifier(state, frame);
	if (frame.emitted || !frame.identifier || !frame.num) return;
	emit(state, {
		type: "level",
		level: {
			levelType: frame.levelType,
			levelIndex: USC_LEVEL_INDEX[frame.levelType],
			identifier: frame.identifier,
			num: frame.num,
			heading: frame.heading,
			titleNum: state.titleNum,
			parentIdentifier: frame.parentIdentifier,
		},
	});
	frame.emitted = true;
}

function emitPendingLevels(state: ParserState) {
	for (const frame of state.levelStack) {
		if (!frame.emitted) {
			emitLevel(state, frame);
		}
	}
}

function handleOpenTag(state: ParserState, tag: ExtractedTag) {
	const tagName = normalizeTagName(tag.name);
	const parentTag = state.tagStack[state.tagStack.length - 1];
	state.tagStack.push(tagName);

	const attrs = tag.attributes;
	const identifier = getAttr(attrs, "identifier");
	const value = getAttr(attrs, "value");
	const topic = getAttr(attrs, "topic");
	const role = getAttr(attrs, "role");

	if (!state.docIdentifier && identifier) {
		state.docIdentifier = identifier;
		ensureTitleNum(state, identifier);
	}

	if (tagName === "meta") {
		state.metaDepth += 1;
	}

	if (state.metaDepth > 0 && tagName === "title") {
		state.metaTitleCapture = true;
		state.metaTitleBuffer = "";
	}

	if (tagName === "title" && parentTag === "main") {
		if (identifier) {
			ensureTitleNum(state, identifier);
		}
		emitTitleIfNeeded(state);
	}

	if (tagName === "note") {
		state.noteDepth += 1;
	}

	if (tagName === "quotedContent") {
		state.quotedContentDepth += 1;
	}

	if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
		const levelType = tagName as USCLevelType;
		const levelNum = parseLevelNumFromIdentifier(identifier, levelType);
		const parentIdentifier =
			state.levelStack.length > 0
				? state.levelStack[state.levelStack.length - 1].identifier
				: `${state.titleNum}-title`;

		const frame: LevelFrame = {
			levelType,
			num: levelNum,
			identifier: levelNum
				? `${state.titleNum}-${LEVEL_ID_PREFIXES[levelType]}${levelNum}`
				: null,
			heading: "",
			parentIdentifier,
			emitted: false,
			bracketedNum: false,
		};
		state.levelStack.push(frame);
	}

	if (tagName === "section") {
		if (state.noteDepth > 0 || state.quotedContentDepth > 0) {
			state.ignoredSectionDepth += 1;
			return;
		}
		emitPendingLevels(state);
		const sectionNum = parseSectionFromIdentifier(identifier);

		const parentLevel = state.levelStack[state.levelStack.length - 1];
		const parentLevelId = parentLevel?.identifier
			? `lvl_usc_${parentLevel.levelType}_${parentLevel.identifier}`
			: `lvl_usc_title_${state.titleNum}`;

		state.currentSection = {
			titleNum: state.titleNum,
			sectionNum,
			heading: "",
			bodyParts: [],
			historyShort: "",
			historyLongParts: [],
			citationsParts: [],
			parentLevelId,
			bracketedNum: false,
		};
		return;
	}

	if (state.currentSection) {
		if (
			SECTION_SKIP_TAGS.has(tagName) ||
			((tagName === "num" || tagName === "heading") && parentTag === "section")
		) {
			state.skipDepth += 1;
		}

		if (tagName === "num" && value && !state.currentSection.sectionNum) {
			state.currentSection.sectionNum = stripLeadingZeros(value);
		}

		if (tagName === "sourceCredit") {
			state.sourceCreditDepth += 1;
			state.sourceCreditBuffer = "";
		}

		if (SECTION_BODY_TAGS.has(tagName) && state.skipDepth === 0) {
			state.bodyCaptureDepth += 1;
			if (state.bodyCaptureDepth === 1) {
				state.bodyBuffer = "";
			}
		}

		if (
			tagName === "heading" &&
			parentTag !== "section" &&
			state.skipDepth === 0 &&
			!state.currentNote &&
			state.noteDepth === 0 &&
			state.bodyCaptureDepth > 0
		) {
			state.bodyHeadingDepth += 1;
			if (state.bodyHeadingDepth === 1) {
				state.bodyHeadingBuffer = "";
			}
		}

		if (tagName === "note") {
			state.currentNote = {
				topic: topic ?? "",
				role: role ?? "",
				headingText: "",
				pParts: [],
			};
		}

		if (state.currentNote && tagName === "p") {
			state.notePDepth += 1;
			if (state.notePDepth === 1) {
				state.notePBuffer = "";
			}
		}
	}

	if (tagName === "heading") {
		if (state.currentNote) {
			if (!state.currentNote.headingText) {
				state.headingTarget = "note";
				state.headingBuffer = "";
			}
		} else if (state.currentSection && parentTag === "section") {
			state.headingTarget = "section";
			state.headingBuffer = "";
		} else if (state.levelStack.length > 0 && USC_LEVEL_SET.has(parentTag)) {
			state.headingTarget = "level";
			state.headingBuffer = "";
		}
	}

	if (tagName === "num") {
		state.numDepth += 1;
		if (state.numDepth === 1) {
			state.numBuffer = "";
			if (state.currentSection) {
				state.numTarget = "section";
			} else if (state.levelStack.length > 0) {
				state.numTarget = "level";
			} else {
				state.numTarget = null;
			}
		}
	}
}

function handleText(state: ParserState, text: ExtractedText) {
	const textValue = text.value;

	if (state.metaTitleCapture) {
		state.metaTitleBuffer += textValue;
	}

	if (state.headingTarget) {
		state.headingBuffer += textValue;
	}

	if (state.numDepth > 0) {
		state.numBuffer += textValue;
	}

	if (
		state.currentSection &&
		state.bodyCaptureDepth > 0 &&
		state.skipDepth === 0 &&
		state.bodyHeadingDepth === 0
	) {
		state.bodyBuffer += textValue;
	}

	if (state.bodyHeadingDepth > 0) {
		state.bodyHeadingBuffer += textValue;
	}

	if (state.sourceCreditDepth > 0) {
		state.sourceCreditBuffer += textValue;
	}

	if (state.notePDepth > 0) {
		state.notePBuffer += textValue;
	}
}

function handleCloseTag(state: ParserState, tag: ExtractedTag) {
	const tagName = normalizeTagName(tag.name);
	state.tagStack.pop();

	if (tagName === "section" && state.ignoredSectionDepth > 0) {
		state.ignoredSectionDepth -= 1;
		return;
	}

	if (tagName === "meta") {
		state.metaDepth -= 1;
	}

	if (state.metaTitleCapture && tagName === "title" && state.metaDepth > 0) {
		const candidate = state.metaTitleBuffer.trim();
		if (candidate) {
			state.titleName = candidate;
		}
		state.metaTitleCapture = false;
		state.metaTitleBuffer = "";
	}

	if (state.headingTarget && tagName === "heading") {
		let heading = normalizedWhitespace(state.headingBuffer);
		if (state.headingTarget === "note" && state.currentNote) {
			state.currentNote.headingText = heading;
		}
		if (state.headingTarget === "section" && state.currentSection) {
			if (state.currentSection.bracketedNum && heading.endsWith("]")) {
				heading = heading.slice(0, -1).trim();
			}
			state.currentSection.heading = heading;
		}
		if (state.headingTarget === "level" && state.levelStack.length > 0) {
			const frame = state.levelStack[state.levelStack.length - 1];
			if (frame.bracketedNum && heading.endsWith("]")) {
				heading = heading.slice(0, -1).trim();
			}
			frame.heading = heading;
			emitLevel(state, frame);
		}
		state.headingTarget = null;
		state.headingBuffer = "";
	}

	if (state.bodyHeadingDepth > 0 && tagName === "heading") {
		state.bodyHeadingDepth -= 1;
		if (state.bodyHeadingDepth === 0) {
			const heading = normalizedWhitespace(state.bodyHeadingBuffer);
			if (heading) {
				const headingLine = `**${heading}**`;
				if (state.bodyBuffer && !/\s$/.test(state.bodyBuffer)) {
					state.bodyBuffer += " ";
				}
				state.bodyBuffer += `${headingLine}\n\n`;
			}
			state.bodyHeadingBuffer = "";
		}
	}

	if (
		state.currentSection &&
		(SECTION_SKIP_TAGS.has(tagName) ||
			((tagName === "num" || tagName === "heading") &&
				state.tagStack.at(-1) === "section"))
	) {
		state.skipDepth -= 1;
	}

	if (tagName === "num" && state.numDepth > 0) {
		state.numDepth -= 1;
		if (state.numDepth === 0) {
			const text = state.numBuffer.trim();
			if (text.startsWith("[")) {
				if (state.numTarget === "section" && state.currentSection) {
					state.currentSection.bracketedNum = true;
				}
				if (state.numTarget === "level" && state.levelStack.length > 0) {
					const frame = state.levelStack[state.levelStack.length - 1];
					frame.bracketedNum = true;
				}
			}
			state.numBuffer = "";
			state.numTarget = null;
		}
	}

	if (
		state.currentSection &&
		SECTION_BODY_TAGS.has(tagName) &&
		state.skipDepth === 0
	) {
		state.bodyCaptureDepth -= 1;
		if (state.bodyCaptureDepth === 0) {
			const text = state.bodyBuffer.trim();
			if (text) {
				state.currentSection.bodyParts.push(text);
			}
			state.bodyBuffer = "";
		}
	}

	if (tagName === "sourceCredit") {
		state.sourceCreditDepth -= 1;
		if (state.sourceCreditDepth === 0 && state.currentSection) {
			state.currentSection.historyShort = normalizedWhitespace(
				state.sourceCreditBuffer,
			);
			state.sourceCreditBuffer = "";
		}
	}

	if (state.currentNote && tagName === "p" && state.notePDepth > 0) {
		state.notePDepth -= 1;
		if (state.notePDepth === 0) {
			const text = normalizedWhitespace(state.notePBuffer);
			if (text) {
				state.currentNote.pParts.push(text);
			}
			state.notePBuffer = "";
		}
	}

	if (state.currentNote && tagName === "note") {
		const heading = state.currentNote.headingText;
		const body = normalizedWhitespace(state.currentNote.pParts.join("\n\n"));
		const finalBody = body || heading;

		if (state.currentSection && (finalBody || state.currentNote.topic)) {
			if (
				state.currentNote.topic === "amendments" ||
				heading.toLowerCase().includes("amendments")
			) {
				if (finalBody) {
					state.currentSection.historyLongParts.push(finalBody);
				}
			} else if (
				state.currentNote.role.includes("crossHeading") ||
				heading.includes("Editorial") ||
				heading.includes("Statutory")
			) {
				// Skip editorial/statutory notes
			} else if (finalBody) {
				state.currentSection.citationsParts.push({
					heading,
					body: finalBody,
				});
			}
		}

		state.currentNote = null;
	}

	if (tagName === "note") {
		state.noteDepth -= 1;
	}

	if (tagName === "quotedContent") {
		state.quotedContentDepth -= 1;
	}

	if (tagName === "section" && state.currentSection) {
		const baseSectionNum = state.currentSection.sectionNum;
		if (baseSectionNum) {
			const sectionKey = `${state.titleNum}-${baseSectionNum}`;
			const count = state.sectionCounts.get(sectionKey) ?? 0;
			state.sectionCounts.set(sectionKey, count + 1);
			const finalSectionNum =
				count === 0 ? baseSectionNum : `${baseSectionNum}-${count + 1}`;

			const body = normalizedWhitespace(
				state.currentSection.bodyParts.join("\n\n"),
			);
			const historyLong = state.currentSection.historyLongParts.join("\n\n");
			const citations = state.currentSection.citationsParts
				.filter(({ body: entryBody }) => entryBody)
				.map(({ heading, body: entryBody }) =>
					heading ? `${heading}\n${entryBody}` : entryBody,
				)
				.join("\n\n")
				.trim();

			const section: USCSection = {
				titleNum: state.titleNum,
				sectionNum: finalSectionNum,
				heading: state.currentSection.heading,
				body,
				historyShort: state.currentSection.historyShort,
				historyLong,
				citations,
				path: `/statutes/usc/section/${state.titleNum}/${finalSectionNum}`,
				docId: `doc_usc_${state.titleNum}-${finalSectionNum}`,
				levelId: `lvl_usc_section_${state.titleNum}-${finalSectionNum}`,
				parentLevelId: state.currentSection.parentLevelId,
			};

			emit(state, { type: "section", section });
		}
		state.currentSection = null;
	}

	if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
		const frame = state.levelStack[state.levelStack.length - 1];
		if (frame) {
			emitLevel(state, frame);
			state.levelStack.pop();
		}
	}
}

function handleEvent(state: ParserState, event: SaxEvent) {
	switch (event.type) {
		case "openTag":
			handleOpenTag(state, event.tag);
			break;
		case "text":
			handleText(state, event.text);
			break;
		case "closeTag":
			handleCloseTag(state, event.tag);
			break;
	}
}

export async function* streamUSCXml(
	input: string,
	fileTitle: string,
	_sourceUrl: string,
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	const state = createParserState(fileTitle);

	await parseXmlWithHandler(input, (event) => {
		handleEvent(state, event);
	});

	// Yield all accumulated events
	for (const evt of state.events) {
		yield evt;
	}

	return { titleNum: state.titleNum, titleName: state.titleName };
}

/**
 * Stream USC XML parsing from chunked input.
 * Yields events as they are parsed from each chunk, keeping memory usage bounded.
 */
export async function* streamUSCXmlFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	fileTitle: string,
	_sourceUrl: string,
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	const state = createParserState(fileTitle);

	await parseXmlStreamWithHandler(chunks, (event) => {
		handleEvent(state, event);
	});

	// Yield all accumulated events
	for (const evt of state.events) {
		yield evt;
	}

	return { titleNum: state.titleNum, titleName: state.titleName };
}

/**
 * Parse a single USC XML file and extract all sections and organizational levels
 */
export async function parseUSCXml(
	xmlContent: string,
	fileTitle: string,
	sourceUrl: string,
): Promise<{
	sections: USCSection[];
	levels: USCLevel[];
	titleNum: string;
	titleName: string;
}> {
	const stream = streamUSCXml(xmlContent, fileTitle, sourceUrl);
	const sections: USCSection[] = [];
	const levels: USCLevel[] = [];

	let result = await stream.next();
	while (!result.done) {
		const event = result.value;
		if (event.type === "section") {
			sections.push(event.section);
		}
		if (event.type === "level") {
			levels.push(event.level);
		}
		result = await stream.next();
	}

	const { titleNum, titleName } = result.value;
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
