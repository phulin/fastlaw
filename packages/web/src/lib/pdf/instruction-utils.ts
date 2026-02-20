import amendmentGrammarSource from "../../../amendment-grammar.bnf?raw";
import { ScopeKind, type TargetScopeSegment } from "../amendment-edit-tree";
import {
	HandcraftedInstructionParser,
	type ParsedInstruction,
} from "../handcrafted-instruction-parser";
import { type NodeContent, type Paragraph, ParagraphRange } from "../types";

const CODE_REFERENCE_TITLE_RE = /^(\d+)\s+U\.S\.C\.$/i;
const EN_DASH = /\u2013/g;
const instructionParser = new HandcraftedInstructionParser(
	amendmentGrammarSource,
);

export interface ParsedInstructionSpan {
	startParagraphIndex: number;
	endParagraphIndex: number;
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

export const findBillSectionForInstruction = (
	paragraphs: readonly Paragraph[],
	startParagraphIndex: number,
): string | null => {
	for (let index = startParagraphIndex; index >= 0; index -= 1) {
		const text = paragraphs[index]?.text.trim();
		if (!text) continue;
		if (/^SEC\.\s+\d+/i.test(text)) return text;
		if (
			/^(?:TITLE|Subtitle|CHAPTER|SUBCHAPTER|PART)\s+[A-Z0-9]+[\s.—-]/i.test(
				text,
			)
		) {
			return text;
		}
	}
	return null;
};

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
	while (paragraphIndex < paragraphs.length) {
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

				if (startParaIdx === -1 && start <= pEnd) {
					startParaIdx = i;
					startFirstOffset = Math.max(0, start - pStart);
				}
				if (end > pStart) {
					endParaIdx = i;
					endLastOffset = Math.min(pLen, end - pStart);
				}

				currentOffset += pLen + 1; // +1 for the "\n"
			}

			if (startParaIdx === -1) return new ParagraphRange([], 0, 0);
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
