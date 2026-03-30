import {
	ScopeKind,
	type TargetScopeSegment,
} from "../../../amendment-edit-tree";
import amendmentGrammarSource from "../../../amendment-grammar.bnf?raw";
import {
	type NodeContent,
	type Paragraph,
	ParagraphRange,
} from "../../../types";
import {
	HandcraftedInstructionParser,
	type ParsedInstruction,
} from "../../amendment-parser/handcrafted-instruction-parser";

const CODE_REFERENCE_TITLE_RE = /^(\d+)\s+U\.S\.C\.$/i;
const EN_DASH = /\u2013/g;
const BILL_SECTION_RE = /^SEC\.\s+\d+/i;
const BILL_DIVISION_RE =
	/^(?:TITLE|Subtitle|CHAPTER|SUBCHAPTER|PART)\s+[A-Z0-9]+[\s.—-]/i;
const TITLE_HEADING_RE = /^TITLE\s+([A-Z0-9IVXLCDM]+)/i;
const TITLE_WIDE_REFERENCE_RE =
	/\bwhenever\s+in\s+this\s+title\b[\s\S]*\breference\s+shall\s+be\s+considered\s+to\s+be\s+made\s+to\b/i;
const TITLE_UNDERLYING_RE = /title\s+(\d+),\s+United States Code/i;
const INTERNAL_REVENUE_CODE_RE = /\bInternal Revenue Code of 1986\b/i;
const instructionParser = new HandcraftedInstructionParser(
	amendmentGrammarSource,
);

export interface ParsedInstructionSpan {
	startParagraphIndex: number;
	endParagraphIndex: number;
	billSection: string | null;
	paragraphRange: ParagraphRange;
	parsedInstruction: ParsedInstruction;
}

export const getSectionBodyText = (
	content: NodeContent | undefined,
): string => {
	if (!content) return "";
	return content.blocks
		.filter((block) => block.type === "body")
		.map((block) => block.content ?? "")
		.join("\n\n");
};

export const getUscSectionPathFromScopePath = (
	targetScopePath: TargetScopeSegment[] | undefined,
): string | null => {
	if (!targetScopePath) return null;
	const hasNoteReference = targetScopePath.some(
		(segment) => segment.kind === "note_reference",
	);
	if (hasNoteReference) return null;
	const codeReference = targetScopePath.find(
		(
			segment,
		): segment is Extract<TargetScopeSegment, { kind: "code_reference" }> =>
			segment.kind === "code_reference",
	);
	const section = targetScopePath.find(
		(segment): segment is { kind: ScopeKind.Section; label: string } =>
			segment.kind === ScopeKind.Section,
	);
	if (!codeReference || !section) return null;
	const title = codeReference.label.match(CODE_REFERENCE_TITLE_RE)?.[1];
	if (!title) return null;
	const normalizedSectionLabel = section.label.replace(EN_DASH, "-");
	return `/statutes/usc/section/${title}/${encodeURIComponent(normalizedSectionLabel)}`;
};

export const getUscCitationFromScopePath = (
	targetScopePath: TargetScopeSegment[] | undefined,
): string | null => {
	if (!targetScopePath) return null;
	const codeReference = targetScopePath.find(
		(
			segment,
		): segment is Extract<TargetScopeSegment, { kind: "code_reference" }> =>
			segment.kind === "code_reference",
	);
	const section = targetScopePath.find(
		(segment): segment is { kind: ScopeKind.Section; label: string } =>
			segment.kind === ScopeKind.Section,
	);
	if (!codeReference || !section) return null;
	const title = codeReference.label.match(CODE_REFERENCE_TITLE_RE)?.[1];
	if (!title) return null;
	const noteReference = targetScopePath.find(
		(
			segment,
		): segment is Extract<TargetScopeSegment, { kind: "note_reference" }> =>
			segment.kind === "note_reference",
	);
	const noteSuffix = noteReference ? ` ${noteReference.label}` : "";
	return `${title} U.S.C. ${section.label}${noteSuffix}`;
};

export const formatTargetScopePath = (
	targetScopePath: TargetScopeSegment[] | undefined,
): string =>
	targetScopePath
		?.map((segment) => `${segment.kind}:${segment.label}`)
		.join(" > ") ?? "";

function upperBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		const value = values[mid];
		if (value <= target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function paragraphIndexForOffset(
	paragraphStartOffsets: readonly number[],
	offset: number,
): number {
	if (paragraphStartOffsets.length === 0) return -1;
	if (offset < 0) return 0;
	const index = upperBound(paragraphStartOffsets, offset) - 1;
	if (index < 0) return 0;
	if (index >= paragraphStartOffsets.length) {
		return paragraphStartOffsets.length - 1;
	}
	return index;
}

function clampOffset(value: number, max: number): number {
	if (value < 0) return 0;
	if (value > max) return max;
	return value;
}

function resolveAbsoluteParagraphRange(
	paragraphs: readonly Paragraph[],
	paragraphStartOffsets: readonly number[],
	paragraphEndOffsets: readonly number[],
	start: number,
	end: number,
): ParagraphRange {
	if (paragraphs.length === 0) return new ParagraphRange([], 0, 0);

	const lastParagraphIndex = paragraphs.length - 1;
	let startParagraphIndex = paragraphIndexForOffset(
		paragraphStartOffsets,
		start,
	);
	if (
		startParagraphIndex < lastParagraphIndex &&
		start === paragraphEndOffsets[startParagraphIndex]
	) {
		startParagraphIndex += 1;
	}
	const startParagraph = paragraphs[startParagraphIndex];
	if (!startParagraph) return new ParagraphRange([], 0, 0);
	const startFirstOffset = clampOffset(
		start - paragraphStartOffsets[startParagraphIndex],
		startParagraph.text.length,
	);

	let endParagraphIndex = paragraphIndexForOffset(
		paragraphStartOffsets,
		end - 1,
	);
	if (endParagraphIndex < startParagraphIndex) {
		endParagraphIndex = startParagraphIndex;
	}
	const endParagraph = paragraphs[endParagraphIndex];
	if (!endParagraph) return new ParagraphRange([], 0, 0);
	const endLastOffset = clampOffset(
		end - paragraphStartOffsets[endParagraphIndex],
		endParagraph.text.length,
	);

	const rangeParagraphs = paragraphs.slice(
		startParagraphIndex,
		endParagraphIndex + 1,
	);
	return new ParagraphRange(rangeParagraphs, startFirstOffset, endLastOffset);
}

export const discoverParsedInstructionSpans = (
	paragraphs: readonly Paragraph[],
): ParsedInstructionSpan[] => {
	const source = paragraphs.map((paragraph) => paragraph.text).join("\n");
	const paragraphStartOffsets: number[] = [];
	const paragraphEndOffsets: number[] = [];
	let currentOffset = 0;
	for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
		paragraphStartOffsets[paragraphIndex] = currentOffset;
		const paragraphEnd = currentOffset + paragraph.text.length;
		paragraphEndOffsets[paragraphIndex] = paragraphEnd;
		currentOffset = paragraphEnd + 1;
	}

	const spans: ParsedInstructionSpan[] = [];
	let paragraphIndex = 0;
	let currentBillSection: string | null = null;
	while (paragraphIndex < paragraphs.length) {
		const currentParagraphText = paragraphs[paragraphIndex]?.text.trim();
		if (currentParagraphText) {
			if (
				BILL_SECTION_RE.test(currentParagraphText) ||
				BILL_DIVISION_RE.test(currentParagraphText)
			) {
				currentBillSection = currentParagraphText;
			}
		}

		const startOffset = paragraphStartOffsets[paragraphIndex];
		if (typeof startOffset !== "number") break;

		const resolveRange = (start: number, end: number): ParagraphRange => {
			return resolveAbsoluteParagraphRange(
				paragraphs,
				paragraphStartOffsets,
				paragraphEndOffsets,
				startOffset + start,
				startOffset + end,
			);
		};

		const parsed = instructionParser.parseInstructionFromSource(
			source,
			startOffset,
			resolveRange,
			{ allowAnchoredOffsets: false },
		);
		if (!parsed || parsed.parseOffset !== 0) {
			paragraphIndex += 1;
			continue;
		}

		const absoluteEnd = startOffset + parsed.text.length;
		const endParagraphIndex = paragraphIndexForOffset(
			paragraphStartOffsets,
			absoluteEnd - 1,
		);
		if (endParagraphIndex === undefined || endParagraphIndex < paragraphIndex) {
			paragraphIndex += 1;
			continue;
		}

		const instructionParagraphs = paragraphs.slice(
			paragraphIndex,
			endParagraphIndex + 1,
		);
		if (instructionParagraphs.length === 0) {
			paragraphIndex += 1;
			continue;
		}

		const endParagraph = paragraphs[endParagraphIndex];
		spans.push({
			startParagraphIndex: paragraphIndex,
			endParagraphIndex,
			billSection: currentBillSection,
			paragraphRange: new ParagraphRange(
				instructionParagraphs,
				0,
				endParagraph.text.length,
			),
			parsedInstruction: parsed,
		});
		paragraphIndex = endParagraphIndex + 1;
	}
	return spans;
};

export const discoverTitleScopedCodeReferenceDefaults = (
	paragraphs: readonly Paragraph[],
): Map<number, string> => {
	const defaultByTitle = new Map<string, string>();
	const titleByParagraphIndex = new Map<number, string>();
	let currentTitle: string | null = null;

	for (const [index, paragraph] of paragraphs.entries()) {
		const text = paragraph.text.trim();
		const titleMatch = text.match(TITLE_HEADING_RE);
		if (titleMatch?.[1]) {
			currentTitle = titleMatch[1].toUpperCase();
		}
		if (currentTitle) {
			titleByParagraphIndex.set(index, currentTitle);
		}

		const codeReference = parseTitleScopedCodeReference(text);
		if (currentTitle && codeReference) {
			defaultByTitle.set(currentTitle, codeReference);
		}
	}

	const defaultsByParagraph = new Map<number, string>();
	for (const [index, title] of titleByParagraphIndex.entries()) {
		const codeReference = defaultByTitle.get(title);
		if (codeReference) {
			defaultsByParagraph.set(index, codeReference);
		}
	}
	return defaultsByParagraph;
};

function parseTitleScopedCodeReference(text: string): string | null {
	if (!TITLE_WIDE_REFERENCE_RE.test(text)) return null;
	const titleMatch = text.match(TITLE_UNDERLYING_RE);
	if (titleMatch?.[1]) return `${titleMatch[1]} U.S.C.`;
	if (INTERNAL_REVENUE_CODE_RE.test(text)) return "26 U.S.C.";
	return null;
}
