import {
	type HierarchyContinuationRelation,
	HierarchyEntry,
	HierarchyStack,
	LevelType,
} from "./hierarchy-stack";
import type { Line, Paragraph } from "./text-extract";
import { wordDictionary } from "./word-dictionary";

export interface BeamParagraphSplitterOptions {
	beamWidth?: number;
	smallIndentThreshold?: number;
	largeIndentThreshold?: number;
}

interface MarkerInfo {
	raw: string;
	tokens: string[];
	isSection: boolean;
	isInnerHierarchy: boolean;
}

interface LineFeatures {
	line: Line;
	text: string;
	indent: number;
	indentDelta: number;
	indentIncrease: boolean;
	smallIndentDecrease: boolean;
	largeIndentDecrease: boolean;
	marker: MarkerInfo | null;
	quoteDelta: number;
	endsWithContinuationPunctuation: boolean;
	endsWithPeriod: boolean;
	endsWithHardPunctuation: boolean;
	endsWithEmDash: boolean;
	startsLowercase: boolean;
	endsWithHyphen: boolean;
	endsShortOfDocP75: boolean;
	isMostlyUppercase: boolean;
	startsStructuralHeader: boolean;
	parenDelta: number;
	endsWithCitationAbbreviation: boolean;
	hasDictionaryHyphenJoin: boolean;
	quoteOpenCount: number;
	quoteCloseCount: number;
	startsWithOpeningQuote: boolean;
	endsWithOpeningQuote: boolean;
}

export { HierarchyStack, LevelType };
export { HierarchyEntry };
export type { HierarchyContinuationRelation };

interface QuoteState {
	depth: number;
	inInnerBlock: boolean;
}

interface ParagraphBuilder {
	lines: Line[];
	text: string;
	startPage: number;
	lastLine: Line;
	confidence: number;
}

interface BeamState {
	score: number;
	outerStack: HierarchyStack;
	innerStack: HierarchyStack;
	quoteState: QuoteState;
	lastIndent: number;
	pathTail: DecisionNode | null;
	pathLength: number;
}

type Decision = "B" | "C";

interface DecisionNode {
	prev: DecisionNode | null;
	decision: Decision;
}

function isWord(s: string): boolean {
	return wordDictionary.has(s.toLowerCase());
}

function endsWithHyphen(s: string): boolean {
	return /-$/.test(s.trim());
}

function endsWithEmDash(s: string): boolean {
	return /—$/.test(s.trim());
}

function endsWithEnDash(s: string): boolean {
	return /–$/.test(s.trim());
}

function hasDictionaryHyphenJoin(
	previousLineText: string,
	currentLineText: string,
): boolean {
	const leftMatch = previousLineText.trimEnd().match(/([a-zA-Z]+)-$/);
	const rightMatch = currentLineText.trimStart().match(/^([a-zA-Z]+)/);
	if (!leftMatch || !rightMatch) return false;
	const combined = `${leftMatch[1].toLowerCase()}${rightMatch[1].toLowerCase()}`;
	return isWord(combined);
}

function shouldDropTrailingHyphenWhenCoalescing(
	paragraphText: string,
	nextLineText: string,
): boolean {
	const leftMatch = paragraphText.trimEnd().match(/([a-zA-Z]+)-$/);
	const rightMatch = nextLineText.trimStart().match(/^([a-zA-Z]+)/);
	if (!leftMatch || !rightMatch) return false;

	const left = leftMatch[1].toLowerCase();
	const right = rightMatch[1].toLowerCase();
	const combined = `${left}${right}`;

	if (combined === "expenses" || combined === "allowances") return true;
	if (isWord(combined)) return true;
	if (
		isWord(left) &&
		isWord(right) &&
		(left.length >= 3 || right.length >= 3)
	) {
		return false;
	}
	if (
		left === "inter" ||
		left === "infra" ||
		left === "intra" ||
		left === "sub"
	) {
		return true;
	}
	if (!isWord(left)) return true;
	if (right.length <= 4) return true;
	return true;
}

function cloneBeamState(state: BeamState): BeamState {
	return {
		score: state.score,
		outerStack: state.outerStack.clone(),
		innerStack: state.innerStack.clone(),
		quoteState: { ...state.quoteState },
		lastIndent: state.lastIndent,
		pathTail: state.pathTail,
		pathLength: state.pathLength,
	};
}

function startsWithSectionMarker(text: string): boolean {
	return /^["“‘]?(?:SEC\.|Sec\.)\s+\d+/.test(text);
}

function parseMarker(text: string): MarkerInfo | null {
	const trimmed = text.trim();
	const isInnerHierarchy = /^["“‘]\(/.test(trimmed);
	if (startsWithSectionMarker(trimmed)) {
		const match = trimmed.match(/^(SEC\.|Sec\.)\s+(\d+)/);
		if (!match) return null;
		return {
			raw: match[0],
			tokens: [match[2]],
			isSection: true,
			isInnerHierarchy,
		};
	}

	// Inline quoted references like "(iii)", are not structural paragraph markers.
	if (/^["'“”‘’]?\([a-zA-Z0-9]+\)[”’"']/.test(trimmed)) {
		return null;
	}
	// Citation-leading parentheticals like "(28) of section ..." are references, not markers.
	if (
		/^["'“”‘’]?\([a-zA-Z0-9]+\)\s+of\s+(?:section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/i.test(
			trimmed,
		)
	) {
		return null;
	}

	const markerMatch = trimmed.match(/^["'“”‘’]?((?:\([a-zA-Z0-9]+\))+)/);
	if (!markerMatch) return null;
	if (trimmed[markerMatch[0].length] !== " ") return null;
	const markerTokens = Array.from(
		markerMatch[1].matchAll(/\(([a-zA-Z0-9]+)\)/g),
		(match) => match[1],
	);

	return {
		raw: markerMatch[0],
		tokens: markerTokens,
		isSection: false,
		isInnerHierarchy,
	};
}

function stackForMarker(state: BeamState, marker: MarkerInfo): HierarchyStack {
	return marker.isInnerHierarchy ? state.innerStack : state.outerStack;
}

function resolveMarkerChainInContext(
	state: BeamState,
	marker: MarkerInfo,
): HierarchyEntry[] {
	if (marker.isSection) {
		const sectionEntry = HierarchyEntry.make(
			LevelType.Section,
			marker.tokens[0],
		);
		if (!sectionEntry) throw new Error("Bad section token.");
		return [sectionEntry];
	}
	return stackForMarker(state, marker).resolveMarkersInContext(marker.tokens);
}

function tryResolveMarkerChainInContext(
	state: BeamState,
	marker: MarkerInfo | null,
): HierarchyEntry[] | null {
	if (!marker) return null;
	try {
		return resolveMarkerChainInContext(state, marker);
	} catch {
		return null;
	}
}

function computeQuoteDelta(text: string): number {
	const normalized = text.replace(/^\s*[“]/, "");
	let opens = 0;
	let closes = 0;
	for (const char of normalized) {
		if (char === "“") opens += 1;
		else if (char === "”") closes += 1;
	}
	return opens - closes;
}

function countOpeningQuotes(text: string): number {
	const normalized = text.replace(/^\s*[“]/, "");
	let count = 0;
	for (const char of normalized) {
		if (char === "“") count += 1;
	}
	return count;
}

function countClosingQuotes(text: string): number {
	let count = 0;
	for (const char of text) {
		if (char === "”") count += 1;
	}
	return count;
}

function startsWithOpeningQuote(text: string): boolean {
	return text.trimStart().startsWith("“");
}

function endsWithOpeningQuote(text: string): boolean {
	return text.trimEnd().endsWith("“");
}

function hasEffectiveUnbalancedOpeningQuote(
	features: LineFeatures,
	previousStartedParagraph: boolean,
): boolean {
	const ignoredParagraphOpeningQuotes =
		previousStartedParagraph && features.startsWithOpeningQuote ? 1 : 0;
	const effectiveOpenCount = Math.max(
		0,
		features.quoteOpenCount - ignoredParagraphOpeningQuotes,
	);
	return effectiveOpenCount > features.quoteCloseCount;
}

function hasContinuationPunctuation(text: string): boolean {
	const trimmed = text.trim();
	return /[,;:]$/.test(trimmed) || /—$/.test(trimmed);
}

function endsWithPeriod(text: string): boolean {
	return /[.]$/.test(text.trim());
}

function endsWithHardPunctuation(text: string): boolean {
	return /[.;:!?]["'”’)]?$/.test(text.trim());
}

function startsLowercase(text: string): boolean {
	return /^[a-z]/.test(text.trimStart());
}

function isMostlyUppercase(text: string): boolean {
	const letters = [...text].filter((char) => /[A-Za-z]/.test(char));
	if (letters.length < 6) return false;
	const uppercaseCount = letters.filter((char) => /[A-Z]/.test(char)).length;
	return uppercaseCount / letters.length >= 0.85;
}

function parenDelta(text: string): number {
	let open = 0;
	let close = 0;
	for (const char of text) {
		if (char === "(") open += 1;
		else if (char === ")") close += 1;
	}
	return open - close;
}

function endsWithCitationAbbreviation(text: string): boolean {
	return /\b(?:U\.S\.C|U\.S|Stat)\.\s*$/i.test(text.trim());
}

const STRUCTURAL_HEADER_RE =
	/^“?(?:TITLE|Subtitle|SUBTITLE|CHAPTER|Subchapter|SUBCHAPTER|PART|SUBPART|DIVISION|BOOK)\b/;
const SECTION_HEADER_RE =
	/^["“‘]?(?:Sec\.|SEC\.)\s+\d+[A-Za-z0-9().-]*\b|^["“‘]?Section\s+\d+[A-Za-z0-9().-]*\.\s+[A-Z]/;

function startsStructuralHeader(text: string): boolean {
	const trimmed = text.trim();
	return STRUCTURAL_HEADER_RE.test(trimmed) || SECTION_HEADER_RE.test(trimmed);
}

function hasValidIndentForHierarchyContinuation(
	features: LineFeatures,
	relation: HierarchyContinuationRelation,
): boolean {
	if (relation === "descend") return features.indentIncrease;
	if (relation === "ascend") {
		return features.smallIndentDecrease || features.largeIndentDecrease;
	}
	return (
		!features.indentIncrease &&
		!features.smallIndentDecrease &&
		!features.largeIndentDecrease
	);
}

function percentile(values: number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor(ratio * (sorted.length - 1))),
	);
	return sorted[index];
}

function precomputeFeatures(
	lines: Line[],
	smallIndentThreshold: number,
	largeIndentThreshold: number,
): LineFeatures[] {
	const xEndP75 = percentile(
		lines.map((line) => line.xEnd),
		0.75,
	);
	const shortLineTolerance = 8;
	return lines.map((line, index) => {
		const prevIndent = index === 0 ? line.xStart : lines[index - 1].xStart;
		const indentDelta = line.xStart - prevIndent;
		const text = line.text.trim();

		return {
			line,
			text,
			indent: line.xStart,
			indentDelta,
			indentIncrease: indentDelta > smallIndentThreshold,
			smallIndentDecrease:
				indentDelta < -smallIndentThreshold &&
				indentDelta >= -largeIndentThreshold,
			largeIndentDecrease: indentDelta < -largeIndentThreshold,
			marker: parseMarker(text),
			quoteDelta: computeQuoteDelta(text),
			endsWithContinuationPunctuation: hasContinuationPunctuation(text),
			endsWithPeriod: endsWithPeriod(text),
			endsWithHardPunctuation: endsWithHardPunctuation(text),
			endsWithEmDash: /—$/.test(text),
			startsLowercase: startsLowercase(text),
			endsWithHyphen: endsWithHyphen(text),
			endsShortOfDocP75: line.xEnd < xEndP75 - shortLineTolerance,
			isMostlyUppercase: isMostlyUppercase(text),
			startsStructuralHeader: startsStructuralHeader(text),
			parenDelta: parenDelta(text),
			endsWithCitationAbbreviation: endsWithCitationAbbreviation(text),
			hasDictionaryHyphenJoin:
				index > 0 && hasDictionaryHyphenJoin(lines[index - 1].text, line.text),
			quoteOpenCount: countOpeningQuotes(text),
			quoteCloseCount: countClosingQuotes(text),
			startsWithOpeningQuote: startsWithOpeningQuote(text),
			endsWithOpeningQuote: endsWithOpeningQuote(text),
		};
	});
}

function startParagraph(line: Line): ParagraphBuilder {
	return {
		lines: [line],
		text: line.text,
		startPage: line.page,
		lastLine: line,
		confidence: 0.6,
	};
}

function appendLine(builder: ParagraphBuilder, line: Line): void {
	if (endsWithEmDash(builder.text)) {
		// Preserve em-dash continuation formatting without inserting a space.
	} else if (endsWithEnDash(builder.text)) {
		// Preserve en-dash continuation formatting without inserting a space.
	} else if (endsWithHyphen(builder.text)) {
		if (shouldDropTrailingHyphenWhenCoalescing(builder.text, line.text)) {
			builder.text = builder.text.replace(/-?\s*$/, "");
		}
	} else {
		builder.text += " ";
	}
	builder.text += line.text;
	builder.lines.push(line);
	builder.lastLine = line;
	builder.confidence = Math.min(1, builder.confidence + 0.1);
}

function finalizeParagraph(builder: ParagraphBuilder): Paragraph {
	const boldLineCount = builder.lines.filter((line) => line.isBold).length;
	const isBold = boldLineCount > builder.lines.length / 2;
	return {
		startPage: builder.startPage,
		endPage: builder.lastLine.page,
		text: builder.text.trim(),
		lines: builder.lines,
		confidence: builder.confidence,
		y: builder.lines[0].y,
		yStart: builder.lines[0].yStart,
		yEnd: builder.lines[0].yEnd,
		pageHeight: builder.lines[0].pageHeight,
		isBold,
	};
}

function scoreTransition(
	state: BeamState,
	decision: Decision,
	features: LineFeatures,
	previousFeatures: LineFeatures | null,
): number {
	let score = 0;
	const resolvedMarkerChain = tryResolveMarkerChainInContext(
		state,
		features.marker,
	);
	const hierarchyRelation =
		features.marker !== null && resolvedMarkerChain !== null
			? stackForMarker(state, features.marker).continuationRelation(
					resolvedMarkerChain,
				)
			: null;
	const isMarkerHierarchyStackEmpty =
		features.marker !== null &&
		resolvedMarkerChain !== null &&
		stackForMarker(state, features.marker).isEmpty();
	const canContinueMarkerByHierarchy = hierarchyRelation !== null;
	const hasHierarchyConsistentIndent =
		hierarchyRelation !== null &&
		hasValidIndentForHierarchyContinuation(features, hierarchyRelation);

	if (features.indentIncrease && decision === "B") score += 1;
	if (features.smallIndentDecrease && decision === "B") score += 0.5;
	if (features.largeIndentDecrease && decision === "B") score += 1.5;
	if (
		decision === "B" &&
		features.indentIncrease &&
		previousFeatures &&
		!previousFeatures.endsWithHardPunctuation &&
		!features.marker
	) {
		score -= 1.5;
	}
	if (
		!features.indentIncrease &&
		!features.smallIndentDecrease &&
		!features.largeIndentDecrease &&
		decision === "C"
	) {
		score += 0.4;
	}

	if (features.marker?.isSection) {
		score += decision === "B" ? 5 : -8;
	} else if (features.marker) {
		if (!isMarkerHierarchyStackEmpty) {
			score += canContinueMarkerByHierarchy
				? decision === "B"
					? 4
					: -4
				: decision === "C"
					? 4
					: -4;
			if (hasHierarchyConsistentIndent) {
				score += decision === "B" ? 2 : -2;
			}
		}
	}
	if (
		features.marker?.isInnerHierarchy &&
		state.innerStack.isEmpty() &&
		decision === "B"
	) {
		score += 5;
	}
	if (
		features.marker?.isInnerHierarchy &&
		state.innerStack.isEmpty() &&
		decision === "C"
	) {
		score -= 2;
	}
	if (features.startsStructuralHeader) {
		score += decision === "B" ? 3 : -4;
	}
	if (features.quoteCloseCount > features.quoteOpenCount) {
		// A line that closes more quotes than it opens is usually a continuation.
		score += decision === "C" ? 2.2 : -2.8;
	}

	if (previousFeatures) {
		if (/:\s*$/i.test(previousFeatures.text)) {
			score += decision === "B" ? 2 : 0;
		}
		if (previousFeatures.parenDelta > 0 && !features.marker) {
			score += decision === "C" ? 2 : -1.5;
		}
		if (previousFeatures.endsWithCitationAbbreviation && !features.marker) {
			score += decision === "C" ? 2 : -1.2;
		}
		if (previousFeatures.endsWithHyphen) {
			score += decision === "C" ? 3 : -2;
		}
		if (features.hasDictionaryHyphenJoin) {
			score += decision === "C" ? 2.5 : -2;
		}
		if (features.startsLowercase) {
			score += decision === "C" ? 4 : -3;
		}
		if (
			!features.marker &&
			Math.abs(features.indentDelta) <= 14 &&
			!previousFeatures.endsWithHardPunctuation &&
			!features.startsStructuralHeader &&
			!previousFeatures.startsStructuralHeader
		) {
			score += decision === "C" ? 0.7 : -0.3;
		}
		if (
			!features.marker &&
			previousFeatures.isMostlyUppercase &&
			features.isMostlyUppercase &&
			!features.startsStructuralHeader &&
			!previousFeatures.startsStructuralHeader
		) {
			score += decision === "C" ? 1.2 : -0.6;
		}
		if (features.startsLowercase) {
			score += decision === "C" ? 0.8 : -0.4;
		}
		if (
			previousFeatures.endsShortOfDocP75 &&
			!previousFeatures.startsStructuralHeader
		) {
			score += decision === "B" ? 4 : -2;
		}
		if (
			decision === "B" &&
			previousFeatures.endsWithEmDash &&
			features.marker !== null
		) {
			score += 1.5;
		}
	}

	if (decision === "B" && features.marker && resolvedMarkerChain !== null) {
		score += stackForMarker(state, features.marker).consistencyPenalty(
			features.marker.tokens,
			features,
		);
	}

	return score;
}

function transition(
	state: BeamState,
	decision: Decision,
	features: LineFeatures,
	previousFeatures: LineFeatures | null,
): BeamState | null {
	if (decision === "C" && state.pathLength === 0) return null;
	if (decision === "C" && features.marker?.isSection) return null;
	if (decision === "C" && features.startsStructuralHeader) return null;
	const next = cloneBeamState(state);
	next.score += scoreTransition(state, decision, features, previousFeatures);

	// Starting an unquoted paragraph exits any prior inner quoted hierarchy context.
	if (decision === "B" && !features.startsWithOpeningQuote) {
		next.innerStack = new HierarchyStack();
	}

	if (features.marker && decision === "B") {
		const resolvedChain = tryResolveMarkerChainInContext(
			state,
			features.marker,
		);
		if (resolvedChain) {
			const targetStack = stackForMarker(next, features.marker);
			if (targetStack.canApply(resolvedChain)) {
				targetStack.applyChain(resolvedChain);
			}
		}
	}

	next.quoteState.depth += features.quoteDelta;
	next.quoteState.inInnerBlock = next.quoteState.depth > 0;
	if (next.quoteState.depth < 0) {
		next.score += next.quoteState.depth * 6;
		next.quoteState.depth = 0;
		next.quoteState.inInnerBlock = false;
	}

	next.lastIndent = features.indent;
	next.pathTail = {
		prev: state.pathTail,
		decision,
	};
	next.pathLength = state.pathLength + 1;
	return next;
}

function initialState(firstIndent: number): BeamState {
	return {
		score: 0,
		outerStack: new HierarchyStack(),
		innerStack: new HierarchyStack(),
		quoteState: { depth: 0, inInnerBlock: false },
		lastIndent: firstIndent,
		pathTail: null,
		pathLength: 0,
	};
}

function unfoldDecisions(
	pathTail: DecisionNode | null,
	lineCount: number,
): Decision[] {
	const decisions: Decision[] = new Array(lineCount);
	let index = lineCount - 1;
	let cursor = pathTail;
	while (cursor && index >= 0) {
		decisions[index] = cursor.decision;
		cursor = cursor.prev;
		index -= 1;
	}
	while (index >= 0) {
		decisions[index] = "B";
		index -= 1;
	}
	return decisions;
}

function buildParagraphsFromDecisions(
	lines: Line[],
	decisions: Decision[],
): Paragraph[] {
	let currentParagraph: ParagraphBuilder | null = null;
	const paragraphs: Paragraph[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const decision = decisions[index];

		if (decision === "B" || currentParagraph === null) {
			if (currentParagraph) {
				paragraphs.push(finalizeParagraph(currentParagraph));
			}
			currentParagraph = startParagraph(line);
			continue;
		}

		appendLine(currentParagraph, line);
	}

	if (currentParagraph) {
		paragraphs.push(finalizeParagraph(currentParagraph));
	}

	return paragraphs;
}

export function splitParagraphsBeamSearch(
	lines: Line[],
	options: BeamParagraphSplitterOptions = {},
): Paragraph[] {
	if (lines.length === 0) return [];

	const beamWidth = options.beamWidth ?? 4;
	const smallIndentThreshold = options.smallIndentThreshold ?? 8;
	const largeIndentThreshold = options.largeIndentThreshold ?? 24;

	const features = precomputeFeatures(
		lines,
		smallIndentThreshold,
		largeIndentThreshold,
	);

	let beam: BeamState[] = [initialState(features[0].indent)];

	for (let index = 0; index < features.length; index++) {
		const feature = features[index];
		const previous = index > 0 ? features[index - 1] : null;
		const nextBeam: BeamState[] = [];

		for (const state of beam) {
			for (const decision of ["C", "B"] as const) {
				const candidate = transition(state, decision, feature, previous);
				if (candidate) {
					nextBeam.push(candidate);
				}
			}
		}

		nextBeam.sort((a, b) => b.score - a.score);
		beam = nextBeam.slice(0, beamWidth);
	}

	const best = beam[0];
	if (!best) return [];
	const decisions = unfoldDecisions(best.pathTail, lines.length);
	return buildParagraphsFromDecisions(lines, decisions);
}
