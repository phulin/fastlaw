import {
	getScopeRangeFromNodeId,
	parseMarkdownToPlainDocument,
} from "./amendment-document-model";
import type {
	ClassificationOverride,
	DocumentModel,
	FormattingSpan,
	OperationMatchAttempt,
	PlanEditsResult,
	PlannedPatch,
	ResolvedInstructionOperation,
	ScopeRange,
} from "./amendment-edit-engine-types";
import {
	applyAttemptOutcome,
	countPatchesByOperation,
	selectNonOverlappingPatches,
} from "./amendment-edit-patch-utils";
import { handleInsertEdit } from "./amendment-edit-planner/handlers/insert";
import { handleMoveEdit } from "./amendment-edit-planner/handlers/move";
import { handleRedesignateEdit } from "./amendment-edit-planner/handlers/redesignate";
import { handleRewriteEdit } from "./amendment-edit-planner/handlers/rewrite";
import { handleStrikeEdit } from "./amendment-edit-planner/handlers/strike";
import { handleStrikeInsertEdit } from "./amendment-edit-planner/handlers/strike-insert";
import {
	type InnerLocationTarget,
	InnerLocationTargetKind,
	PunctuationKind,
	type TextWithProvenance,
	textFromEditTarget,
	textSearchFromEditTarget,
	UltimateEditKind,
} from "./amendment-edit-tree";
import { findAnchorSearchMatch } from "./anchor-search";
import { formatInsertedBlockContent } from "./inserted-block-format";
import { segment } from "./sentence-segment";
import type { ParagraphRange } from "./types";

/**
 * Searches text for occurrences of "section X", and replaces X using base section
 * translations based on D1 classification tables.
 */
function translateCrossReferences(
	text: string,
	classificationOverrides?: ClassificationOverride[],
): string {
	if (!classificationOverrides || classificationOverrides.length === 0)
		return text;

	// matches e.g. "section 3(a)(1)" or "sections 3 and 4"
	// we want to catch the base numbers.
	return text.replace(
		/(sections?\s+)([\d\w\-()]+)(\s+and\s+[\d\w\-()]+)?/gi,
		(_match, prefix, baseSection, andPart) => {
			let translatedBase = baseSection;
			// Extract just the core number/letter part, ignoring subsections like (a)(1)
			const baseMatch = baseSection.match(/^([^()]+)/);
			const baseNum = baseMatch ? baseMatch[1] : baseSection;

			const override = classificationOverrides.find(
				(o) => o.pubLawSec === baseNum,
			);
			if (override?.uscSection) {
				translatedBase = baseSection.replace(baseNum, override.uscSection);
			}

			let translatedAndPart = andPart ?? "";
			if (andPart) {
				const andBaseMatch = andPart.match(/\s+and\s+([^()]+)/);
				if (andBaseMatch?.[1]) {
					const andBaseNum = andBaseMatch[1];
					const andOverride = classificationOverrides?.find(
						(o) => o.pubLawSec === andBaseNum,
					);
					if (andOverride?.uscSection) {
						translatedAndPart = andPart.replace(
							andBaseNum,
							andOverride.uscSection,
						);
					}
				}
			}

			return `${prefix}${translatedBase}${translatedAndPart}`;
		},
	);
}

function computeFallbackAnchorRegexSearch(anchorText: string): RegExp | null {
	// If the anchor mentions a section number, wildcard it so "section 1916" can
	// match "section 1396o" (SSA → USC codification discrepancy).
	const match = anchorText.match(/section\s+([^()\s]+)/i);
	if (!match || !match[1]) return null;

	const pubLawSec = match[1];
	const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regexStr = escaped.replace(
		new RegExp(
			`section\\s+${pubLawSec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			"i",
		),
		"section\\s+(?<base>\\S+?)",
	);
	return new RegExp(regexStr, "i");
}

function computeFallbackRegexSearch(
	strikeText: string,
	classificationOverrides?: ClassificationOverride[],
): RegExp | null {
	// If the strike text mentions a section, we can make the base section a wildcard
	const match = strikeText.match(/section\s+([^()]+)(?:\([^)]+\))*/i);
	if (!match || !match[1]) return null;

	const pubLawSec = match[1];

	// If we have overrides, verify that this is a section that *would* be translated.
	// If we don't have overrides, we'll do a "blind" wildcard match which is riskier
	// but often necessary for tests that don't provide the table.
	if (classificationOverrides && classificationOverrides.length > 0) {
		const override = classificationOverrides.find(
			(o) => o.pubLawSec === pubLawSec,
		);
		if (!override?.uscSection) return null;
	}

	// Escape the rest of the string but replace the base section with a wildcard
	const escaped = strikeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regexStr = escaped.replace(
		new RegExp(
			`section\\s+${pubLawSec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			"i",
		),
		"section\\s+(?<base>\\S+?)",
	);
	return new RegExp(regexStr, "i");
}

function previewRange(text: string, range: ScopeRange | null): string {
	if (!range) return "";
	return text.slice(range.start, Math.min(range.end, range.start + 180));
}

function punctuationText(kind: PunctuationKind): string {
	switch (kind) {
		case PunctuationKind.Period:
			return ".";
		case PunctuationKind.Comma:
			return ",";
		case PunctuationKind.Semicolon:
			return ";";
	}
}

function findPunctuationIndexAtEnd(
	scopedText: string,
	kind: PunctuationKind,
): number {
	const punctuation = punctuationText(kind);
	const trimmedEnd = scopedText.trimEnd();
	return trimmedEnd.lastIndexOf(punctuation);
}

function paragraphTexts(range: ParagraphRange): string[] {
	return range.paragraphs.map((p, i) => {
		if (i === 0 && i === range.paragraphs.length - 1) {
			return p.text.slice(range.startFirst, range.endLast);
		} else if (i === 0) {
			return p.text.slice(range.startFirst);
		} else if (i === range.paragraphs.length - 1) {
			return p.text.slice(0, range.endLast);
		}
		return p.text;
	});
}

function formatContentRanges(
	content: TextWithProvenance,
	baseDepth: number,
): TextWithProvenance {
	const { paragraphs } = content.sourceLocation;
	const hasLevelInfo = paragraphs.some((p) => p.level !== undefined);
	if (!hasLevelInfo) {
		return {
			text: formatInsertedBlockContent(content.text, {
				baseDepth,
				quotePlainMultiline: true,
			}),
			sourceLocation: content.sourceLocation,
		};
	}
	const texts = paragraphTexts(content.sourceLocation);
	const formattedText = texts
		.map((text, i) => {
			const paragraphLevel = paragraphs[i]?.level;
			const depth =
				paragraphLevel === undefined
					? baseDepth
					: Math.max(0, paragraphLevel - 1);
			return formatInsertedBlockContent(text, {
				baseDepth: depth,
				quotePlainMultiline: true,
			});
		})
		.join("\n");
	return { text: formattedText, sourceLocation: content.sourceLocation };
}

function formatInsertionContent(
	content: TextWithProvenance,
	indent: number,
): TextWithProvenance {
	return formatContentRanges(content, indent + 1);
}

function formatReplacementContent(
	content: TextWithProvenance,
	indent: number,
): TextWithProvenance {
	return formatContentRanges(content, indent);
}

function paragraphIndentAtOffset(
	model: DocumentModel,
	offset: number,
): number | null {
	const paragraph = model.paragraphs.find(
		(candidate) => candidate.start <= offset && candidate.end > offset,
	);
	return paragraph?.indent ?? null;
}

function formatStrikeInsertReplacementText(args: {
	model: DocumentModel;
	content: TextWithProvenance;
	insertStart: number;
	fallbackIndent: number;
}): string {
	const { model, content, insertStart, fallbackIndent } = args;
	if (!content.text.includes("\n")) return content.text;
	const hostIndent =
		paragraphIndentAtOffset(model, insertStart) ?? fallbackIndent;
	const isMidLineInsertion =
		insertStart > 0 && model.plainText[insertStart - 1] !== "\n";
	if (!isMidLineInsertion) {
		return formatReplacementContent(content, hostIndent).text;
	}

	const lines = content.text.split("\n");
	if (lines.length <= 1) return content.text;
	const [firstLine = "", ...remainingLines] = lines;
	const continuationLine = firstLine.trim().length > 0;
	if (!continuationLine || isStructuralMarkerLine(firstLine)) {
		return formatInsertedBlockContent(content.text, {
			baseDepth: hostIndent + 1,
			quotePlainMultiline: true,
		});
	}

	const remainingText = remainingLines.join("\n");
	const formattedRemaining = formatInsertedBlockContent(remainingText, {
		baseDepth: hostIndent + 1,
		quotePlainMultiline: true,
	});
	return `${firstLine}\n${formattedRemaining}`;
}

function multilineReplacementSuffix(
	inserted: TextWithProvenance,
	text: string,
	rangeEnd: number,
): string {
	if (!inserted.text.includes("\n")) return "";
	if (inserted.text.endsWith("\n")) return "";
	const nextChar = text[rangeEnd] ?? "";
	if (nextChar.length === 0 || nextChar === "\n") return "";
	return "\n";
}

function boundaryAwareReplacementSuffix(
	inserted: TextWithProvenance,
	deleted: string,
	text: string,
	rangeEnd: number,
): string {
	if (deleted.endsWith("\n") && !inserted.text.endsWith("\n")) {
		return "\n";
	}
	return multilineReplacementSuffix(inserted, text, rangeEnd);
}

function normalizeInsertedSpans(
	spans: FormattingSpan[],
	insertedPlain: string,
): FormattingSpan[] {
	if (insertedPlain.length === 0) return [];
	const hasMultiline = insertedPlain.includes("\n");
	const preserveSingleLineStructuralParagraph =
		!hasMultiline && isStructuralMarkerWithBodyLine(insertedPlain);
	return spans
		.filter((span) => {
			if (span.type === "insertion" || span.type === "deletion") return false;
			if (!hasMultiline) {
				if (preserveSingleLineStructuralParagraph) {
					return span.type !== "heading";
				}
				return span.type !== "paragraph" && span.type !== "heading";
			}
			return true;
		})
		.map((span) => ({ ...span }));
}

function stripQuotePrefix(line: string): string {
	let working = line.trimStart();
	while (working.startsWith(">")) {
		working = working.slice(1).trimStart();
	}
	return working;
}

function isStructuralMarkerLine(line: string): boolean {
	const stripped = stripQuotePrefix(line);
	return /^\([A-Za-z0-9ivxIVX]+\)(?:\s|$)/.test(stripped);
}

function isStructuralMarkerWithBodyLine(line: string): boolean {
	const stripped = stripQuotePrefix(line);
	return /^\([A-Za-z0-9ivxIVX]+\)(?:\([A-Za-z0-9ivxIVX]+\))*\s+\S/.test(
		stripped,
	);
}

const MARKER_LINE_WITH_PREFIX_RE =
	/^(\s*(?:>\s*)*)((?:\([A-Za-z0-9ivxIVX]+\))+)\s+([A-Za-z0-9][A-Za-z0-9 '"()\-.,/&;]*?)\.\u2014(?:\s*(.*))?$/;
const MARKER_PARAGRAPH_RE =
	/^(\s*)((?:\([A-Za-z0-9ivxIVX]+\))+)(?:\s+([\s\S]*))?$/;

function lowercaseHeadingWithUppercaseFirstCharacter(text: string): string {
	if (text.length === 0) return text;
	const lower = text.toLowerCase();
	return lower[0].toUpperCase() + lower.slice(1);
}

function normalizeInsertedMarkerHeadings(sourceText: string): string {
	if (sourceText.length === 0) return sourceText;
	const lines = sourceText.split("\n");
	const normalized: string[] = [];
	for (const line of lines) {
		const match = line.match(MARKER_LINE_WITH_PREFIX_RE);
		if (!match) {
			normalized.push(line);
			continue;
		}
		const prefix = match[1] ?? "";
		const marker = match[2] ?? "";
		const heading = lowercaseHeadingWithUppercaseFirstCharacter(
			(match[3] ?? "").trim(),
		);
		const tail = (match[4] ?? "").trim();
		normalized.push(`${prefix}${marker} ${heading}`);
		if (tail.length > 0) {
			normalized.push("");
			normalized.push(`${prefix}${tail}`);
		}
	}
	return normalized.join("\n");
}

function withSymbolicMarkerHeadingSpans(
	spans: FormattingSpan[],
	plainText: string,
): FormattingSpan[] {
	const output = spans.map((span) => ({ ...span }));
	const paragraphSpans = output
		.filter((span) => span.type === "paragraph")
		.sort((left, right) => left.start - right.start || left.end - right.end);

	const hasStrongSpan = (start: number, end: number): boolean =>
		output.some(
			(span) =>
				span.type === "strong" && span.start === start && span.end === end,
		);

	for (const paragraph of paragraphSpans) {
		const text = plainText.slice(paragraph.start, paragraph.end);
		const match = text.match(MARKER_PARAGRAPH_RE);
		if (!match) continue;

		const leading = match[1] ?? "";
		const marker = match[2] ?? "";
		const trailing = (match[3] ?? "").trim();
		if (marker.length === 0) continue;

		const markerStart = paragraph.start + leading.length;
		const markerEnd = markerStart + marker.length;
		if (markerEnd > markerStart && !hasStrongSpan(markerStart, markerEnd)) {
			output.push({ start: markerStart, end: markerEnd, type: "strong" });
		}

		// When marker-heading lines are split from ".—" forms (e.g. "(1) Premiums"),
		// add a strong span for the heading text as well.
		if (trailing.length > 0 && !/[.!?;:]$/.test(trailing)) {
			let headingStart = markerEnd;
			while (
				headingStart < paragraph.end &&
				/\s/.test(plainText[headingStart] ?? "")
			) {
				headingStart += 1;
			}
			let headingEnd = paragraph.end;
			while (
				headingEnd > headingStart &&
				/\s/.test(plainText[headingEnd - 1] ?? "")
			) {
				headingEnd -= 1;
			}
			if (
				headingEnd > headingStart &&
				!hasStrongSpan(headingStart, headingEnd)
			) {
				output.push({ start: headingStart, end: headingEnd, type: "strong" });
			}
		}
	}

	return output.sort(
		(left, right) =>
			left.start - right.start ||
			left.end - right.end ||
			left.type.localeCompare(right.type),
	);
}

function normalizeInsertedParagraphBoundaries(sourceText: string): string {
	if (!sourceText.includes("\n")) return sourceText;
	const lines = sourceText.split("\n");
	const expandedLines = lines.flatMap((line) =>
		splitInlineStructuralMarkers(line),
	);
	const normalized: string[] = [];
	for (let index = 0; index < expandedLines.length; index += 1) {
		const currentLine = expandedLines[index] ?? "";
		const nextLine = expandedLines[index + 1];
		const previousLine =
			normalized.length > 0 ? (normalized[normalized.length - 1] ?? "") : "";
		if (
			currentLine.trim().length > 0 &&
			isStructuralMarkerLine(currentLine) &&
			previousLine.trim().length > 0
		) {
			normalized.push("");
		}
		normalized.push(currentLine);
		if (nextLine === undefined) continue;
		if (currentLine.trim().length === 0 || nextLine.trim().length === 0)
			continue;
		if (!isStructuralMarkerLine(currentLine)) continue;
		if (!isStructuralMarkerLine(nextLine)) continue;
		normalized.push("");
	}
	return normalized.join("\n");
}

function splitInlineStructuralMarkers(line: string): string[] {
	if (line.trim().length === 0) return [line];

	const prefixMatch = line.match(/^(\s*(?:>\s*)*)/);
	const prefix = prefixMatch?.[1] ?? "";
	const content = line.slice(prefix.length);
	const parts = content
		.split(/(?<=[.;:])\s+(?=\([A-Za-z0-9ivxIVX]+\)\s+[A-Z])/g)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length <= 1) return [line];

	return parts.map((part) => `${prefix}${part}`);
}

function parseInsertedText(sourceText: string): {
	insertedPlain: string;
	insertedSpans: FormattingSpan[];
} {
	if (sourceText.length === 0) {
		return { insertedPlain: "", insertedSpans: [] };
	}
	const normalizedSourceText = normalizeInsertedParagraphBoundaries(
		normalizeInsertedMarkerHeadings(sourceText),
	);
	const normalizedSourceWithHeadings =
		normalizeInsertedMarkerHeadings(normalizedSourceText);
	const parsed = parseMarkdownToPlainDocument(normalizedSourceWithHeadings);
	const symbolicSpans = withSymbolicMarkerHeadingSpans(
		parsed.spans,
		parsed.plainText,
	);
	return {
		insertedPlain: parsed.plainText,
		insertedSpans: normalizeInsertedSpans(symbolicSpans, parsed.plainText),
	};
}

function formatBlockInsertionContent(
	content: TextWithProvenance,
	indent: number,
): TextWithProvenance {
	return formatContentRanges(content, indent + 1);
}

function resolveSentenceOrdinalRange(
	text: string,
	ordinal: number,
): { start: number; end: number } | null {
	const sentences = segment("en", text);
	if (sentences.length === 0) return null;

	const validSentences: { text: string; start: number; end: number }[] = [];
	let cursor = 0;
	for (const s of sentences) {
		const start = cursor;
		const end = cursor + s.length;
		cursor = end;

		const trimmed = s.trim();
		if (!/[a-zA-Z0-9]/.test(trimmed)) {
			continue;
		}

		if (trimmed.startsWith("—") && validSentences.length > 0) {
			const prev = validSentences[validSentences.length - 1];
			if (prev) {
				prev.text += s;
				prev.end = end;
			}
			continue;
		}

		const isHeader =
			!/[.!?]['"]?$/.test(trimmed) &&
			trimmed.length < 150 &&
			!trimmed.includes("\n");
		if (isHeader) {
			continue;
		}

		validSentences.push({ text: s, start, end });
	}

	if (validSentences.length === 0) return null;
	const sentenceIndex =
		ordinal <= 0
			? validSentences.length - 1
			: Math.min(ordinal - 1, validSentences.length - 1);
	const sentence = validSentences[sentenceIndex];
	if (!sentence) return null;
	return { start: sentence.start, end: sentence.end };
}

function resolveLeadingSectionDesignationRange(
	scopedText: string,
): { start: number; end: number } | null {
	const markerMatch = scopedText.match(/^\s*\([A-Za-z0-9ivxIVX]+\)/);
	if (!markerMatch) return null;
	return {
		start: markerMatch.index ?? 0,
		end: (markerMatch.index ?? 0) + markerMatch[0].length,
	};
}

function resolveLeadingSubsectionHeadingRange(
	scopedText: string,
): { start: number; end: number } | null {
	const designation = resolveLeadingSectionDesignationRange(scopedText);
	if (!designation) return null;

	let headingStart = designation.end;
	while (
		headingStart < scopedText.length &&
		/\s/.test(scopedText[headingStart] ?? "")
	) {
		headingStart += 1;
	}
	if (headingStart >= scopedText.length) return null;

	const paragraphEnd = scopedText.indexOf("\n", headingStart);
	const searchEnd = paragraphEnd >= 0 ? paragraphEnd : scopedText.length;
	const emDashIndex = scopedText.indexOf("—", headingStart);
	if (emDashIndex >= 0 && emDashIndex < searchEnd) {
		return {
			start: headingStart,
			end: emDashIndex,
		};
	}

	let headingEnd = searchEnd;
	while (
		headingEnd > headingStart &&
		/\s/.test(scopedText[headingEnd - 1] ?? "")
	) {
		headingEnd -= 1;
	}
	if (headingEnd <= headingStart) return null;
	return { start: headingStart, end: headingEnd };
}

function resolveHeadingSpanRange(
	model: DocumentModel,
	range: ScopeRange,
): { start: number; end: number } | null {
	const headingSpan = model.spans.find(
		(span) =>
			span.type === "heading" &&
			span.start >= range.start &&
			span.end <= range.end,
	);
	if (!headingSpan) return null;
	return { start: headingSpan.start, end: headingSpan.end };
}

function resolveInnerLocationRangeInScope(
	model: DocumentModel,
	range: ScopeRange,
	target: InnerLocationTarget,
): ScopeRange | null {
	const scopedText = model.plainText.slice(range.start, range.end);
	switch (target.kind) {
		case InnerLocationTargetKind.Punctuation: {
			const punctuationIndex = findPunctuationIndexAtEnd(
				scopedText,
				target.punctuation,
			);
			if (punctuationIndex < 0) return null;
			const punctuation = punctuationText(target.punctuation);
			return {
				start: range.start + punctuationIndex,
				end: range.start + punctuationIndex + punctuation.length,
				indent: range.indent,
			};
		}
		case InnerLocationTargetKind.SectionDesignation: {
			const designation = resolveLeadingSectionDesignationRange(scopedText);
			if (!designation) return null;
			return {
				start: range.start + designation.start,
				end: range.start + designation.end,
				indent: range.indent,
			};
		}
		case InnerLocationTargetKind.SubsectionHeading: {
			const heading = resolveLeadingSubsectionHeadingRange(scopedText);
			if (!heading) return null;
			return {
				start: range.start + heading.start,
				end: range.start + heading.end,
				indent: range.indent,
			};
		}
		case InnerLocationTargetKind.Heading: {
			const heading = resolveHeadingSpanRange(model, range);
			if (heading) {
				return {
					start: heading.start,
					end: heading.end,
					indent: range.indent,
				};
			}
			const subsectionHeading =
				resolveLeadingSubsectionHeadingRange(scopedText);
			if (!subsectionHeading) return null;
			return {
				start: range.start + subsectionHeading.start,
				end: range.start + subsectionHeading.end,
				indent: range.indent,
			};
		}
		case InnerLocationTargetKind.SentenceOrdinal:
		case InnerLocationTargetKind.SentenceLast: {
			const ordinal =
				target.kind === InnerLocationTargetKind.SentenceLast
					? -1
					: target.ordinal;
			const sentenceRange = resolveSentenceOrdinalRange(scopedText, ordinal);
			if (!sentenceRange) return null;
			return {
				start: range.start + sentenceRange.start,
				end: range.start + sentenceRange.end,
				indent: range.indent,
			};
		}
	}
}

function extractAnchor(
	nodeText: string,
	direction: "before" | "after",
): string | null {
	const pattern = new RegExp(`${direction}\\s+["""„‟'']([^""'']+)[""'']`, "i");
	const match = nodeText.match(pattern);
	return match?.[1] ?? null;
}

function escapeRegex(source: string): string {
	return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveInlineMatterBoundary(
	scopedText: string,
	refKind: string | null,
	refLabel: string | null,
): number | null {
	if (!refKind || !refLabel) return null;
	const trimmedLabel = refLabel.trim();
	if (trimmedLabel.length === 0) return null;
	const kindsUsingParenMarkers = new Set([
		"paragraph",
		"subparagraph",
		"clause",
		"subclause",
		"item",
		"subitem",
	]);
	if (!kindsUsingParenMarkers.has(refKind)) return null;
	const marker = `(${trimmedLabel})`;
	const pattern = new RegExp(`(^|\\s)${escapeRegex(marker)}(\\s|$)`);
	const match = pattern.exec(scopedText);
	if (!match || match.index === undefined) return null;
	return match.index + match[1].length;
}

function trimLeadingSubsectionHeadingFromRange(
	model: DocumentModel,
	range: ScopeRange,
): ScopeRange {
	const leadingParagraph = model.spans.find(
		(span) =>
			span.type === "paragraph" &&
			span.start <= range.start &&
			span.end > range.start,
	);
	if (!leadingParagraph) return range;
	if (leadingParagraph.end >= range.end) return range;

	const leadingText = model.plainText.slice(
		leadingParagraph.start,
		leadingParagraph.end,
	);
	if (!/^\s*\([A-Za-z0-9ivxIVX]+\)\s+/.test(leadingText)) return range;

	const strongSpans = model.spans
		.filter(
			(span) =>
				span.type === "strong" &&
				span.end > leadingParagraph.start &&
				span.start < leadingParagraph.end,
		)
		.map((span) => ({
			start: Math.max(span.start, leadingParagraph.start),
			end: Math.min(span.end, leadingParagraph.end),
		}));
	if (strongSpans.length === 0) return range;

	for (
		let index = leadingParagraph.start;
		index < leadingParagraph.end;
		index += 1
	) {
		const char = model.plainText[index] ?? "";
		if (/\s/.test(char)) continue;
		const covered = strongSpans.some(
			(span) => span.start <= index && index < span.end,
		);
		if (!covered) return range;
	}

	let trimmedStart = leadingParagraph.end;
	while (trimmedStart < range.end && model.plainText[trimmedStart] === "\n") {
		trimmedStart += 1;
	}
	if (trimmedStart >= range.end) return range;
	return { ...range, start: trimmedStart };
}

function getEditStrikingContent(
	operation: ResolvedInstructionOperation,
): string | null {
	const { edit } = operation;
	if (edit.kind === UltimateEditKind.Strike) {
		return textFromEditTarget(edit.target);
	}
	if (edit.kind === UltimateEditKind.StrikeInsert) {
		return textFromEditTarget(edit.strike);
	}
	return null;
}

function overlaps(left: PlannedPatch, right: PlannedPatch): boolean {
	const leftPoint = left.start === left.end;
	const rightPoint = right.start === right.end;
	if (leftPoint && rightPoint && left.start === right.start) return false;
	return left.start < right.end && right.start < left.end;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
	if (needle.length === 0) return [];
	const indexes: number[] = [];
	let cursor = 0;
	while (cursor <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index < 0) break;
		indexes.push(index);
		cursor = index + needle.length;
	}
	return indexes;
}

function normalizeInlineDeletionRange(
	text: string,
	start: number,
	end: number,
): { start: number; end: number } {
	if (start >= end) return { start, end };
	const deleted = text.slice(start, end);
	if (deleted.includes("\n")) return { start, end };
	const beforeChar = text[start - 1] ?? "";
	const afterChar = text[end] ?? "";
	if (beforeChar === " " && afterChar === " ") {
		return { start: start - 1, end };
	}
	return { start, end };
}

function buildAttempt(
	operation: ResolvedInstructionOperation,
	range: ScopeRange | null,
	plainText: string,
): OperationMatchAttempt {
	return {
		operationType: operation.edit.kind,
		nodeText: operation.nodeText,
		originalNodeText: operation.originalNodeText,
		scopeContextTexts: operation.scopeContextTexts,
		strikingContent: getEditStrikingContent(operation),
		targetPath: operation.targetPathText,
		hasExplicitTargetPath: operation.hasExplicitTargetPath,
		scopedRange: range
			? {
					start: range.start,
					end: range.end,
					length: range.end - range.start,
					preview: previewRange(plainText, range),
				}
			: null,
		searchText: null,
		searchTextKind: "none",
		searchIndex: null,
		patchApplied: false,
		wasTranslated: false,
		translatedInstructionText: null,
		outcome: "no_patch",
	};
}

function planPatchForOperation(
	model: DocumentModel,
	operation: ResolvedInstructionOperation,
	classificationOverrides?: ClassificationOverride[],
): { patches: PlannedPatch[]; attempt: OperationMatchAttempt } {
	const plainText = model.plainText;
	const baseRange = getScopeRangeFromNodeId(model, operation.resolvedTargetId);
	let range = baseRange;
	const attempt = buildAttempt(operation, range, plainText);

	const translatedNodeText = translateCrossReferences(
		operation.nodeText,
		classificationOverrides,
	);
	if (translatedNodeText !== operation.nodeText) {
		attempt.wasTranslated = true;
		attempt.translatedInstructionText = translatedNodeText;
	}

	if (operation.hasExplicitTargetPath && !operation.resolvedTargetId) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}
	if (!range && operation.edit.kind !== UltimateEditKind.Move) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}

	if (range && operation.hasMatterPrecedingTarget) {
		if (!operation.resolvedMatterPrecedingTargetId) {
			const inlineBoundary = resolveInlineMatterBoundary(
				plainText.slice(range.start, range.end),
				operation.matterPrecedingRefKind,
				operation.matterPrecedingRefLabel,
			);
			if (inlineBoundary === null) {
				attempt.outcome = "scope_unresolved";
				return { patches: [], attempt };
			}
			range = { ...range, end: range.start + inlineBoundary };
		} else {
			const matterTargetRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedMatterPrecedingTargetId,
			);
			if (!matterTargetRange) {
				attempt.outcome = "scope_unresolved";
				return { patches: [], attempt };
			}
			const boundary = Math.min(matterTargetRange.start, range.end);
			range = { ...range, end: Math.max(range.start, boundary) };
		}
		range = trimLeadingSubsectionHeadingFromRange(model, range);
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	if (range && operation.hasMatterFollowingTarget) {
		if (!operation.resolvedMatterFollowingTargetId) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const matterTargetRange = getScopeRangeFromNodeId(
			model,
			operation.resolvedMatterFollowingTargetId,
		);
		if (!matterTargetRange) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const boundary = Math.max(matterTargetRange.end, range.start);
		range = { ...range, start: Math.min(boundary, range.end) };
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	if (range && typeof operation.sentenceOrdinal === "number") {
		const sentenceRange = resolveSentenceOrdinalRange(
			plainText.slice(range.start, range.end),
			operation.sentenceOrdinal,
		);
		if (sentenceRange) {
			const baseStart = range.start;
			range = {
				...range,
				start: baseStart + sentenceRange.start,
				end: baseStart + sentenceRange.end,
			};
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: range.end - range.start,
				preview: previewRange(plainText, range),
			};
		} else {
			range = { ...range, start: range.end };
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: 0,
				preview: "",
			};
		}
	}

	if (range && operation.beforeInnerTarget) {
		const innerRange = resolveInnerLocationRangeInScope(
			model,
			range,
			operation.beforeInnerTarget,
		);
		if (!innerRange) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		range = { ...range, end: Math.max(range.start, innerRange.start) };
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	if (range && operation.afterInnerTarget) {
		const innerRange = resolveInnerLocationRangeInScope(
			model,
			range,
			operation.afterInnerTarget,
		);
		if (!innerRange) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		range = { ...range, start: Math.min(range.end, innerRange.end) };
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	const scopedText = range ? plainText.slice(range.start, range.end) : "";
	const patches: PlannedPatch[] = [];
	const pushPatch = (args: {
		start: number;
		end: number;
		deleted: string;
		inserted?: string;
		insertedPrefixPlain?: string;
		insertedSuffixPlain?: string;
		insertAt?: number;
	}) => {
		const inserted = parseInsertedText(args.inserted ?? "");
		patches.push({
			operationIndex: operation.operationIndex,
			start: args.start,
			end: args.end,
			insertAt:
				args.insertAt ?? (args.start < args.end ? args.end : args.start),
			deletedPlain: args.deleted,
			insertedPlain: inserted.insertedPlain,
			insertedSpans: inserted.insertedSpans,
			insertedPrefixPlain: args.insertedPrefixPlain,
			insertedSuffixPlain: args.insertedSuffixPlain,
		});
	};

	switch (operation.edit.kind) {
		case UltimateEditKind.StrikeInsert: {
			handleStrikeInsertEdit({
				model,
				operation,
				range,
				scopedText,
				plainText,
				attempt,
				classificationOverrides,
				pushPatch,
				textSearchFromEditTarget,
				translateCrossReferences,
				punctuationText,
				findPunctuationIndexAtEnd,
				resolveInnerLocationRangeInScope,
				formatStrikeInsertReplacementText,
				formatReplacementContent,
				boundaryAwareReplacementSuffix,
				computeFallbackRegexSearch,
				findAllOccurrences,
			});
			break;
		}

		case UltimateEditKind.Rewrite: {
			handleRewriteEdit({
				operation,
				range,
				scopedText,
				plainText,
				attempt,
				classificationOverrides,
				pushPatch,
				translateCrossReferences,
				formatReplacementContent,
				boundaryAwareReplacementSuffix,
			});
			break;
		}

		case UltimateEditKind.Strike: {
			handleStrikeEdit({
				model,
				operation,
				range,
				scopedText,
				plainText,
				attempt,
				classificationOverrides,
				pushPatch,
				textSearchFromEditTarget,
				textFromEditTarget,
				punctuationText,
				findPunctuationIndexAtEnd,
				resolveInnerLocationRangeInScope,
				computeFallbackRegexSearch,
				findAllOccurrences,
				normalizeInlineDeletionRange,
			});
			break;
		}

		case UltimateEditKind.Insert: {
			handleInsertEdit({
				model,
				operation,
				range,
				scopedText,
				plainText,
				attempt,
				classificationOverrides,
				pushPatch,
				textFromEditTarget,
				translateCrossReferences,
				findAnchorSearchMatch,
				computeFallbackAnchorRegexSearch,
				extractAnchor,
				formatInsertionContent,
				formatBlockInsertionContent,
			});
			break;
		}

		case UltimateEditKind.Redesignate: {
			handleRedesignateEdit({
				operation,
				range,
				scopedText,
				attempt,
				pushPatch,
			});
			break;
		}

		case UltimateEditKind.Move: {
			handleMoveEdit({
				model,
				operation,
				plainText,
				pushPatch,
			});
		}
	}

	return { patches, attempt };
}

export function planOperationEdit(
	model: DocumentModel,
	operation: ResolvedInstructionOperation,
	classificationOverrides?: ClassificationOverride[],
): { patches: PlannedPatch[]; attempt: OperationMatchAttempt } {
	return planPatchForOperation(model, operation, classificationOverrides);
}

export function planEdits(
	model: DocumentModel,
	operations: ResolvedInstructionOperation[],
	classificationOverrides?: ClassificationOverride[],
): PlanEditsResult {
	const attempts: OperationMatchAttempt[] = [];
	const tentativePatches: PlannedPatch[] = [];

	for (const operation of operations) {
		const { patches, attempt } = planPatchForOperation(
			model,
			operation,
			classificationOverrides,
		);
		attempts.push(attempt);
		tentativePatches.push(...patches);
	}

	const accepted = selectNonOverlappingPatches(
		tentativePatches.sort(
			(left, right) =>
				left.operationIndex - right.operationIndex || left.start - right.start,
		),
		overlaps,
	);
	const appliedCountByOperation = countPatchesByOperation(accepted);
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		if (!attempt) continue;
		applyAttemptOutcome(attempt, appliedCountByOperation.get(index) ?? 0);
	}

	return {
		patches: accepted.sort(
			(left, right) =>
				left.operationIndex - right.operationIndex || left.start - right.start,
		),
		attempts,
	};
}
