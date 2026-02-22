import amendmentGrammarSource from "../../../amendment-grammar.bnf?raw";
import { ScopeKind, type TargetScopeSegment } from "../amendment-edit-tree";
import {
	HandcraftedInstructionParser,
	type ParsedInstruction,
} from "../handcrafted-instruction-parser";
import { type NodeContent, type Paragraph, ParagraphRange } from "../types";

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
	return `${title} U.S.C. ${section.label}`;
};

export const formatTargetScopePath = (
	targetScopePath: TargetScopeSegment[] | undefined,
): string =>
	targetScopePath
		?.map((segment) => `${segment.kind}:${segment.label}`)
		.join(" > ") ?? "";

export const discoverParsedInstructionSpans = (
	paragraphs: readonly Paragraph[],
): ParsedInstructionSpan[] => {
	const paragraphStartLineIndexes: number[] = [];
	const lines: string[] = [];
	const lineToParagraphIndex: number[] = [];

	for (
		let paragraphIndex = 0;
		paragraphIndex < paragraphs.length;
		paragraphIndex += 1
	) {
		paragraphStartLineIndexes.push(lines.length);
		const paragraphLines = paragraphs[paragraphIndex]?.text.split("\n") ?? [""];
		for (const line of paragraphLines) {
			lines.push(line);
			lineToParagraphIndex.push(paragraphIndex);
		}
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

		const startLineIndex = paragraphStartLineIndexes[paragraphIndex];
		if (startLineIndex === undefined) break;

		const sourceParagraphs = paragraphs.slice(paragraphIndex);
		const resolveRange = (start: number, end: number): ParagraphRange => {
			let currentOffset = 0;
			let startParaIdx = -1;
			let endParaIdx = -1;
			let startFirstOffset = 0;
			let endLastOffset = 0;

			for (let i = 0; i < sourceParagraphs.length; i++) {
				const pLen = sourceParagraphs[i].text.length;
				const pStart = currentOffset;
				const pEnd = currentOffset + pLen;
				const isLastParagraph = i === sourceParagraphs.length - 1;

				if (startParaIdx === -1) {
					if (start < pEnd || (start === pEnd && isLastParagraph)) {
						startParaIdx = i;
						startFirstOffset = Math.max(0, Math.min(pLen, start - pStart));
					} else if (start === pEnd && !isLastParagraph) {
						startParaIdx = i + 1;
						startFirstOffset = 0;
					}
				}
				if (end > pStart) {
					endParaIdx = i;
					endLastOffset = Math.min(pLen, end - pStart);
				}

				currentOffset += pLen + (isLastParagraph ? 0 : 1); // "\n" separator between paragraphs only
			}

			if (startParaIdx === -1) return new ParagraphRange([], 0, 0);
			if (startParaIdx >= sourceParagraphs.length) {
				startParaIdx = sourceParagraphs.length - 1;
				startFirstOffset = sourceParagraphs[startParaIdx]?.text.length ?? 0;
			}
			if (endParaIdx === -1) endParaIdx = startParaIdx;

			const rangeParagraphs = sourceParagraphs.slice(
				startParaIdx,
				endParaIdx + 1,
			);
			if (rangeParagraphs.length === 0) return new ParagraphRange([], 0, 0);

			return new ParagraphRange(
				rangeParagraphs,
				startFirstOffset,
				endLastOffset,
			);
		};

		const parsed = instructionParser.parseInstructionFromLines(
			lines,
			startLineIndex,
			resolveRange,
		);
		if (!parsed || parsed.parseOffset !== 0) {
			paragraphIndex += 1;
			continue;
		}

		const endParagraphIndex = lineToParagraphIndex[parsed.endIndex];
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
