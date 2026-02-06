import { Parser } from "htmlparser2";

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

function getAttr(
	attrs: Record<string, string>,
	name: string,
): string | undefined {
	return attrs[name];
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

const USC_LEVEL_SET = new Set<string>(USC_LEVEL_HIERARCHY);

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

function parseLevelNumFromIdentifier(
	ident: string | undefined,
	levelType: USCLevelType,
): string | null {
	if (!ident) return null;
	const rest = ident.replace(/^\/us\/usc\//, "").replace(/^\/+|\/+$/g, "");
	const parts = rest.split("/");
	const prefix = LEVEL_ID_PREFIXES[levelType];

	for (const part of parts) {
		if (!part.startsWith(prefix)) continue;
		const numPart = part.substring(prefix.length);
		if (!numPart || !/^[0-9a-zA-Z]/.test(numPart)) continue;

		let isLongerPrefix = false;
		for (const [otherLevel, otherPrefix] of Object.entries(LEVEL_ID_PREFIXES)) {
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

	return null;
}

export interface USCLevel {
	levelType: USCLevelType;
	levelIndex: number;
	identifier: string;
	num: string;
	heading: string;
	titleNum: string;
	parentIdentifier: string | null;
}

export interface USCSection {
	sectionKey: string;
	titleNum: string;
	sectionNum: string;
	heading: string;
	body: string;
	historyShort: string;
	historyLong: string;
	citations: string;
	path: string;
	docId: string;
	parentRef: USCParentRef;
}

export interface USCSectionRef {
	sectionKey: string;
	titleNum: string;
	sectionNum: string;
	heading: string;
	parentRef: USCParentRef;
}

export type USCParentRef =
	| { kind: "title"; titleNum: string }
	| {
			kind: "level";
			levelType: USCLevelType;
			identifier: string;
	  };

export type USCStreamEvent =
	| { type: "title"; titleNum: string; titleName: string }
	| { type: "level"; level: USCLevel }
	| { type: "section"; section: USCSection };

export type USCStructureEvent =
	| { type: "title"; titleNum: string; titleName: string }
	| { type: "level"; level: USCLevel }
	| { type: "section"; section: USCSectionRef };

export interface USCStreamOptions {
	includeSectionContent?: boolean;
}

interface LevelFrame {
	levelType: USCLevelType;
	num: string | null;
	identifier: string | null;
	heading: string;
	parentIdentifier: string | null;
	emitted: boolean;
	bracketedNum: boolean;
}

interface StructureSectionFrame {
	titleNum: string;
	sectionNum: string | null;
	heading: string;
	parentRef: USCParentRef;
	bracketedNum: boolean;
}

interface FullSectionFrame extends StructureSectionFrame {
	bodyParts: string[];
	historyShort: string;
	historyLongParts: string[];
	citationsParts: Array<{ heading: string; body: string }>;
}

interface NoteFrame {
	topic: string;
	role: string;
	headingText: string;
	pParts: string[];
}

interface SharedDocState {
	tagStack: string[];
	levelStack: LevelFrame[];
	sectionCounts: Map<string, number>;
	titleNum: string;
	titleName: string;
	titleEmitted: boolean;
	metaDepth: number;
	metaTitleCapture: boolean;
	metaTitleBuffer: string;
	numDepth: number;
	numBuffer: string;
	numTarget: "level" | "section" | null;
	noteDepth: number;
	quotedContentDepth: number;
	ignoredSectionDepth: number;
}

interface StructureState extends SharedDocState {
	events: USCStructureEvent[];
	currentSection: StructureSectionFrame | null;
	headingTarget: "level" | "section" | null;
	headingBuffer: string;
}

interface FullState extends SharedDocState {
	events: USCStreamEvent[];
	currentSection: FullSectionFrame | null;
	headingTarget: "level" | "section" | "note" | null;
	headingBuffer: string;
	skipDepth: number;
	bodyCaptureDepth: number;
	bodyBuffer: string;
	sourceCreditDepth: number;
	sourceCreditBuffer: string;
	currentNote: NoteFrame | null;
	notePDepth: number;
	notePBuffer: string;
	bodyHeadingDepth: number;
	bodyHeadingBuffer: string;
}

function createSharedDocState(fileTitle: string): SharedDocState {
	return {
		tagStack: [],
		levelStack: [],
		sectionCounts: new Map(),
		titleNum: fileTitle,
		titleName: "",
		titleEmitted: false,
		metaDepth: 0,
		metaTitleCapture: false,
		metaTitleBuffer: "",
		numDepth: 0,
		numBuffer: "",
		numTarget: null,
		noteDepth: 0,
		quotedContentDepth: 0,
		ignoredSectionDepth: 0,
	};
}

function createStructureState(fileTitle: string): StructureState {
	return {
		...createSharedDocState(fileTitle),
		events: [],
		currentSection: null,
		headingTarget: null,
		headingBuffer: "",
	};
}

function createFullState(fileTitle: string): FullState {
	return {
		...createSharedDocState(fileTitle),
		events: [],
		currentSection: null,
		headingTarget: null,
		headingBuffer: "",
		skipDepth: 0,
		bodyCaptureDepth: 0,
		bodyBuffer: "",
		sourceCreditDepth: 0,
		sourceCreditBuffer: "",
		currentNote: null,
		notePDepth: 0,
		notePBuffer: "",
		bodyHeadingDepth: 0,
		bodyHeadingBuffer: "",
	};
}

function ensureTitleNum(state: SharedDocState, ident?: string) {
	const parsed = parseTitleFromIdentifier(ident);
	if (parsed) {
		state.titleNum = parsed;
	}
}

function ensureLevelIdentifier(state: SharedDocState, frame: LevelFrame) {
	if (frame.identifier || !frame.num) return;
	frame.identifier = `${state.titleNum}-${LEVEL_ID_PREFIXES[frame.levelType]}${frame.num}`;
}

function emitTitleIfNeeded(state: StructureState | FullState) {
	if (state.titleEmitted) return;
	if (!state.titleName) {
		state.titleName = `Title ${state.titleNum}`;
	}
	const event = {
		type: "title" as const,
		titleNum: state.titleNum,
		titleName: state.titleName,
	};
	state.events.push(event);
	state.titleEmitted = true;
}

function emitLevelIfReady(
	state: StructureState | FullState,
	frame: LevelFrame,
) {
	ensureLevelIdentifier(state, frame);
	if (frame.emitted || !frame.identifier || !frame.num) return;
	state.events.push({
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

function emitPendingLevels(state: StructureState | FullState) {
	for (const frame of state.levelStack) {
		emitLevelIfReady(state, frame);
	}
}

function createLevelFrame(
	state: SharedDocState,
	levelType: USCLevelType,
	identifier: string | undefined,
): LevelFrame {
	const levelNum = parseLevelNumFromIdentifier(identifier, levelType);
	const parentIdentifier =
		state.levelStack.length > 0
			? state.levelStack[state.levelStack.length - 1].identifier
			: `${state.titleNum}-title`;
	return {
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
}

function parseSectionParentRef(state: SharedDocState): USCParentRef {
	const parentLevel = state.levelStack[state.levelStack.length - 1];
	if (parentLevel?.identifier) {
		return {
			kind: "level",
			levelType: parentLevel.levelType,
			identifier: parentLevel.identifier,
		};
	}
	return { kind: "title", titleNum: state.titleNum };
}

function closeNumTarget(state: StructureState | FullState) {
	if (state.numDepth === 0) return;
	state.numDepth -= 1;
	if (state.numDepth > 0) return;

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

function closeStructureSection(state: StructureState) {
	if (!state.currentSection?.sectionNum) {
		state.currentSection = null;
		return;
	}

	const baseSectionNum = state.currentSection.sectionNum;
	const sectionKey = `${state.titleNum}-${baseSectionNum}`;
	const count = state.sectionCounts.get(sectionKey) ?? 0;
	state.sectionCounts.set(sectionKey, count + 1);
	const finalSectionNum =
		count === 0 ? baseSectionNum : `${baseSectionNum}-${count + 1}`;

	state.events.push({
		type: "section",
		section: {
			sectionKey: `${state.titleNum}:${finalSectionNum}`,
			titleNum: state.titleNum,
			sectionNum: finalSectionNum,
			heading: state.currentSection.heading,
			parentRef: state.currentSection.parentRef,
		},
	});

	state.currentSection = null;
}

function closeFullSection(state: FullState) {
	if (!state.currentSection?.sectionNum) {
		state.currentSection = null;
		return;
	}

	const baseSectionNum = state.currentSection.sectionNum;
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

	state.events.push({
		type: "section",
		section: {
			sectionKey: `${state.titleNum}:${finalSectionNum}`,
			titleNum: state.titleNum,
			sectionNum: finalSectionNum,
			heading: state.currentSection.heading,
			body,
			historyShort: state.currentSection.historyShort,
			historyLong,
			citations,
			path: `/statutes/usc/section/${state.titleNum}/${finalSectionNum}`,
			docId: `doc_usc_${state.titleNum}-${finalSectionNum}`,
			parentRef: state.currentSection.parentRef,
		},
	});

	state.currentSection = null;
}

function handleSharedOpen(
	state: StructureState | FullState,
	tagName: string,
	parentTag: string | undefined,
	attrs: Record<string, string>,
) {
	const identifier = getAttr(attrs, "identifier");

	if (identifier) {
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
		state.levelStack.push(createLevelFrame(state, levelType, identifier));
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

function handleSharedText(
	state: StructureState | FullState,
	textValue: string,
) {
	if (state.metaTitleCapture) {
		state.metaTitleBuffer += textValue;
	}

	if (state.headingTarget) {
		state.headingBuffer += textValue;
	}

	if (state.numDepth > 0) {
		state.numBuffer += textValue;
	}
}

function handleSharedClose(state: StructureState | FullState, tagName: string) {
	if (tagName === "section" && state.ignoredSectionDepth > 0) {
		state.ignoredSectionDepth -= 1;
		return true;
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

	if (tagName === "num") {
		closeNumTarget(state);
	}

	if (tagName === "note") {
		state.noteDepth -= 1;
	}

	if (tagName === "quotedContent") {
		state.quotedContentDepth -= 1;
	}

	if (USC_LEVEL_SET.has(tagName) && tagName !== "title") {
		const frame = state.levelStack[state.levelStack.length - 1];
		if (frame) {
			emitLevelIfReady(state, frame);
			state.levelStack.pop();
		}
	}

	return false;
}

function handleStructureOpen(
	state: StructureState,
	tagName: string,
	parentTag: string | undefined,
	attrs: Record<string, string>,
) {
	handleSharedOpen(state, tagName, parentTag, attrs);
	const identifier = getAttr(attrs, "identifier");
	const value = getAttr(attrs, "value");

	if (tagName === "section") {
		if (state.noteDepth > 0 || state.quotedContentDepth > 0) {
			state.ignoredSectionDepth += 1;
			return;
		}
		emitPendingLevels(state);
		state.currentSection = {
			titleNum: state.titleNum,
			sectionNum: parseSectionFromIdentifier(identifier),
			heading: "",
			parentRef: parseSectionParentRef(state),
			bracketedNum: false,
		};
		return;
	}

	if (
		state.currentSection &&
		tagName === "num" &&
		value &&
		!state.currentSection.sectionNum
	) {
		state.currentSection.sectionNum = stripLeadingZeros(value);
	}

	if (tagName === "heading") {
		if (state.currentSection && parentTag === "section") {
			state.headingTarget = "section";
			state.headingBuffer = "";
		} else if (
			state.levelStack.length > 0 &&
			USC_LEVEL_SET.has(parentTag ?? "")
		) {
			state.headingTarget = "level";
			state.headingBuffer = "";
		}
	}
}

function handleStructureClose(state: StructureState, tagName: string) {
	if (tagName === "section" && state.ignoredSectionDepth > 0) {
		state.ignoredSectionDepth -= 1;
		return;
	}

	if (state.headingTarget && tagName === "heading") {
		let heading = normalizedWhitespace(state.headingBuffer);
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
			emitLevelIfReady(state, frame);
		}
		state.headingTarget = null;
		state.headingBuffer = "";
	}

	if (tagName === "section" && state.currentSection) {
		closeStructureSection(state);
	}

	handleSharedClose(state, tagName);
}

function handleFullOpen(
	state: FullState,
	tagName: string,
	parentTag: string | undefined,
	attrs: Record<string, string>,
) {
	handleSharedOpen(state, tagName, parentTag, attrs);

	const identifier = getAttr(attrs, "identifier");
	const value = getAttr(attrs, "value");
	const topic = getAttr(attrs, "topic");
	const role = getAttr(attrs, "role");

	if (tagName === "section") {
		if (state.noteDepth > 0 || state.quotedContentDepth > 0) {
			state.ignoredSectionDepth += 1;
			return;
		}
		emitPendingLevels(state);
		state.currentSection = {
			titleNum: state.titleNum,
			sectionNum: parseSectionFromIdentifier(identifier),
			heading: "",
			bodyParts: [],
			historyShort: "",
			historyLongParts: [],
			citationsParts: [],
			parentRef: parseSectionParentRef(state),
			bracketedNum: false,
		};
		return;
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
		} else if (
			state.levelStack.length > 0 &&
			USC_LEVEL_SET.has(parentTag ?? "")
		) {
			state.headingTarget = "level";
			state.headingBuffer = "";
		}
	}

	if (!state.currentSection) {
		return;
	}

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

function handleFullText(state: FullState, textValue: string) {
	handleSharedText(state, textValue);

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

function handleFullClose(state: FullState, tagName: string) {
	if (tagName === "section" && state.ignoredSectionDepth > 0) {
		state.ignoredSectionDepth -= 1;
		return;
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
			emitLevelIfReady(state, frame);
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

	if (tagName === "section" && state.currentSection) {
		closeFullSection(state);
	}

	handleSharedClose(state, tagName);
}

function createStructureParser(state: StructureState): Parser {
	return new Parser(
		{
			onopentag(name, attrs) {
				const tagName = normalizeTagName(name);
				const parentTag = state.tagStack[state.tagStack.length - 1];
				state.tagStack.push(tagName);
				handleStructureOpen(state, tagName, parentTag, attrs);
			},
			ontext(text) {
				handleSharedText(state, text);
			},
			onclosetag(name) {
				const tagName = normalizeTagName(name);
				state.tagStack.pop();
				handleStructureClose(state, tagName);
			},
		},
		{ xmlMode: true, decodeEntities: true },
	);
}

function createFullParser(state: FullState): Parser {
	return new Parser(
		{
			onopentag(name, attrs) {
				const tagName = normalizeTagName(name);
				const parentTag = state.tagStack[state.tagStack.length - 1];
				state.tagStack.push(tagName);
				handleFullOpen(state, tagName, parentTag, attrs);
			},
			ontext(text) {
				handleFullText(state, text);
			},
			onclosetag(name) {
				const tagName = normalizeTagName(name);
				state.tagStack.pop();
				handleFullClose(state, tagName);
			},
		},
		{ xmlMode: true, decodeEntities: true },
	);
}

function drainEvents<T>(events: T[]): T[] {
	if (events.length === 0) return [];
	const drained = [...events];
	events.length = 0;
	return drained;
}

export async function* streamUSCStructureXmlFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	fileTitle: string,
	_sourceUrl: string,
): AsyncGenerator<
	USCStructureEvent,
	{ titleNum: string; titleName: string },
	void
> {
	const state = createStructureState(fileTitle);
	const parser = createStructureParser(state);
	const decoder = new TextDecoder();

	for await (const chunk of chunks) {
		parser.write(decoder.decode(chunk, { stream: true }));
		for (const event of drainEvents(state.events)) {
			yield event;
		}
	}
	parser.write(decoder.decode());
	for (const event of drainEvents(state.events)) {
		yield event;
	}
	parser.end();
	for (const event of drainEvents(state.events)) {
		yield event;
	}

	return {
		titleNum: state.titleNum,
		titleName: state.titleName || `Title ${state.titleNum}`,
	};
}

export async function* streamUSCSectionContentXmlFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	fileTitle: string,
	_sourceUrl: string,
): AsyncGenerator<USCSection, { titleNum: string; titleName: string }, void> {
	const state = createFullState(fileTitle);
	const parser = createFullParser(state);
	const decoder = new TextDecoder();

	for await (const chunk of chunks) {
		parser.write(decoder.decode(chunk, { stream: true }));
		for (const event of drainEvents(state.events)) {
			if (event.type === "section") {
				yield event.section;
			}
		}
	}
	parser.write(decoder.decode());
	for (const event of drainEvents(state.events)) {
		if (event.type === "section") {
			yield event.section;
		}
	}
	parser.end();
	for (const event of drainEvents(state.events)) {
		if (event.type === "section") {
			yield event.section;
		}
	}

	return {
		titleNum: state.titleNum,
		titleName: state.titleName || `Title ${state.titleNum}`,
	};
}

async function* streamUSCXmlFromParser(
	parser: Parser,
	events: USCStreamEvent[],
	chunks: AsyncIterable<string>,
	result: () => { titleNum: string; titleName: string },
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	for await (const chunk of chunks) {
		parser.write(chunk);
		for (const event of drainEvents(events)) {
			yield event;
		}
	}
	parser.end();
	for (const event of drainEvents(events)) {
		yield event;
	}
	return result();
}

export async function* streamUSCXml(
	input: string,
	fileTitle: string,
	_sourceUrl: string,
	options?: USCStreamOptions,
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	if (options?.includeSectionContent === false) {
		const stream = streamUSCStructureXmlFromChunks(
			(async function* () {
				yield new TextEncoder().encode(input);
			})(),
			fileTitle,
			_sourceUrl,
		);

		let result = await stream.next();
		while (!result.done) {
			const event = result.value;
			if (event.type === "section") {
				yield {
					type: "section",
					section: {
						sectionKey: event.section.sectionKey,
						titleNum: event.section.titleNum,
						sectionNum: event.section.sectionNum,
						heading: event.section.heading,
						body: "",
						historyShort: "",
						historyLong: "",
						citations: "",
						path: `/statutes/usc/section/${event.section.titleNum}/${event.section.sectionNum}`,
						docId: `doc_usc_${event.section.titleNum}-${event.section.sectionNum}`,
						parentRef: event.section.parentRef,
					},
				};
			} else {
				yield event;
			}
			result = await stream.next();
		}
		return result.value;
	}

	const state = createFullState(fileTitle);
	const parser = createFullParser(state);
	const chunks = (async function* () {
		yield input;
	})();
	return yield* streamUSCXmlFromParser(parser, state.events, chunks, () => ({
		titleNum: state.titleNum,
		titleName: state.titleName || `Title ${state.titleNum}`,
	}));
}

/**
 * Stream USC XML parsing from chunked input.
 * Yields events as they are parsed from each chunk, keeping memory usage bounded.
 */
export async function* streamUSCXmlFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	fileTitle: string,
	_sourceUrl: string,
	options?: USCStreamOptions,
): AsyncGenerator<
	USCStreamEvent,
	{ titleNum: string; titleName: string },
	void
> {
	if (options?.includeSectionContent === false) {
		const stream = streamUSCStructureXmlFromChunks(
			chunks,
			fileTitle,
			_sourceUrl,
		);
		let result = await stream.next();
		while (!result.done) {
			const event = result.value;
			if (event.type === "section") {
				yield {
					type: "section",
					section: {
						sectionKey: event.section.sectionKey,
						titleNum: event.section.titleNum,
						sectionNum: event.section.sectionNum,
						heading: event.section.heading,
						body: "",
						historyShort: "",
						historyLong: "",
						citations: "",
						path: `/statutes/usc/section/${event.section.titleNum}/${event.section.sectionNum}`,
						docId: `doc_usc_${event.section.titleNum}-${event.section.sectionNum}`,
						parentRef: event.section.parentRef,
					},
				};
			} else {
				yield event;
			}
			result = await stream.next();
		}
		return result.value;
	}

	const state = createFullState(fileTitle);
	const parser = createFullParser(state);
	const decoder = new TextDecoder();
	const textChunks = (async function* () {
		for await (const chunk of chunks) {
			yield decoder.decode(chunk, { stream: true });
		}
		yield decoder.decode();
	})();
	return yield* streamUSCXmlFromParser(
		parser,
		state.events,
		textChunks,
		() => ({
			titleNum: state.titleNum,
			titleName: state.titleName || `Title ${state.titleNum}`,
		}),
	);
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
