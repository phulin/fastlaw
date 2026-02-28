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

const INSIDE_WORD_HYPHEN_RE = /(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/g;

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
		if (marker.length === 0) continue;

		const markerStart = paragraph.start + leading.length;
		const markerEnd = markerStart + marker.length;
		if (markerEnd > markerStart && !hasStrongSpan(markerStart, markerEnd)) {
			output.push({ start: markerStart, end: markerEnd, type: "strong" });
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
			if (!range) break;
			const strikeSearch = textSearchFromEditTarget(operation.edit.strike);
			const strikingContent = strikeSearch?.text ?? null;
			const strikePunctuation =
				"punctuation" in operation.edit.strike
					? operation.edit.strike.punctuation
					: undefined;
			let replacementContentText = operation.edit.insert.text;

			// Extract baseline and translate "section X" in the inserted text
			replacementContentText = translateCrossReferences(
				replacementContentText,
				classificationOverrides,
			);

			const replacementContent = {
				...operation.edit.insert,
				text: replacementContentText,
			};
			const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;
			const atEndSearch = strikeSearch?.atEnd === true;

			if (!strikingContent && strikePunctuation) {
				const punctuation = punctuationText(strikePunctuation);
				const punctuationIndex = findPunctuationIndexAtEnd(
					scopedText,
					strikePunctuation,
				);
				attempt.searchText = punctuation;
				attempt.searchTextKind = "striking";
				attempt.searchIndex =
					punctuationIndex >= 0 ? range.start + punctuationIndex : null;
				if (punctuationIndex < 0) break;

				pushPatch({
					start: range.start + punctuationIndex,
					end: range.start + punctuationIndex + punctuation.length,
					deleted: punctuation,
					inserted: replacementContent.text,
				});
				break;
			}

			if (!strikingContent) {
				// Range replace (through-target)
				if (operation.resolvedThroughTargetId) {
					const throughRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedThroughTargetId,
					);
					if (!throughRange) break;
					const sameTargetLevel =
						throughRange.indent !== undefined &&
						range.indent !== undefined &&
						throughRange.indent === range.indent;
					if (!sameTargetLevel) {
						const formatted = formatReplacementContent(
							replacementContent,
							range.indent ?? 0,
						);
						pushPatch({
							start: range.start,
							end: range.end,
							deleted: scopedText,
							inserted: formatted.text,
							insertedSuffixPlain: boundaryAwareReplacementSuffix(
								formatted,
								scopedText,
								plainText,
								range.end,
							),
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					const formatted = formatReplacementContent(
						replacementContent,
						range.indent ?? 0,
					);
					pushPatch({
						start,
						end,
						deleted: plainText.slice(start, end),
						inserted: formatted.text,
						insertedSuffixPlain: boundaryAwareReplacementSuffix(
							formatted,
							plainText.slice(start, end),
							plainText,
							end,
						),
					});
					break;
				}
				const formatted = formatReplacementContent(
					replacementContent,
					range.indent ?? 0,
				);
				pushPatch({
					start: range.start,
					end: range.end,
					deleted: scopedText,
					inserted: formatted.text,
					insertedSuffixPlain: boundaryAwareReplacementSuffix(
						formatted,
						scopedText,
						plainText,
						range.end,
					),
				});
				break;
			}

			let localIndex =
				operation.atEndOnly || atEndSearch
					? scopedText.lastIndexOf(strikingContent)
					: scopedText.indexOf(strikingContent);
			let resolvedStrikingContent = strikingContent;
			let resolvedReplacementContentText = replacementContent.text;

			if (localIndex < 0 && strikingContent) {
				const fallbackRegex = computeFallbackRegexSearch(
					strikingContent,
					classificationOverrides,
				);
				if (fallbackRegex) {
					const match = scopedText.match(fallbackRegex);
					if (match && match.index !== undefined && match.groups?.base) {
						localIndex = match.index;
						resolvedStrikingContent = match[0];
						attempt.wasTranslated = true;

						// If the replacement string had the identical original base number, use the newly captured one instead.
						// E.g. strike "section 3(a)" insert "section 3(b)", with target "section 1396a(a)"
						const originalPubLawBaseMatch =
							strikingContent.match(/section\s+([^()]+)/i);
						if (originalPubLawBaseMatch?.[1]) {
							const originalPubLawBase = originalPubLawBaseMatch[1];
							// Reconstruct insert using the captured base from target text (match.groups.base)
							// We bypass the global classification translation because we're reusing the exact base from the matched string
							resolvedReplacementContentText =
								operation.edit.insert.text.replace(
									new RegExp(
										`section\\s+${originalPubLawBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
										"i",
									),
									`section ${match.groups.base}`,
								);
						}
					}
				}
			}

			attempt.searchText = resolvedStrikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;

			const resolvedReplacementContent = {
				...replacementContent,
				text: resolvedReplacementContentText,
			};

			if (eachPlaceItAppears) {
				for (const occurrenceIndex of findAllOccurrences(
					scopedText,
					resolvedStrikingContent,
				)) {
					const patchStart = range.start + occurrenceIndex;
					const formattedReplacement = formatStrikeInsertReplacementText({
						model,
						content: resolvedReplacementContent,
						insertStart: patchStart,
						fallbackIndent: range.indent ?? 0,
					});
					pushPatch({
						start: patchStart,
						end: patchStart + resolvedStrikingContent.length,
						deleted: resolvedStrikingContent,
						inserted: formattedReplacement,
					});
				}
				break;
			}

			const patchStart = range.start + localIndex;
			const formattedReplacement = formatStrikeInsertReplacementText({
				model,
				content: resolvedReplacementContent,
				insertStart: patchStart,
				fallbackIndent: range.indent ?? 0,
			});
			pushPatch({
				start: patchStart,
				end: patchStart + resolvedStrikingContent.length,
				deleted: resolvedStrikingContent,
				inserted: formattedReplacement,
			});
			break;
		}

		case UltimateEditKind.Rewrite: {
			if (!range) break;
			let replacementContentText = operation.edit.content.text;
			replacementContentText = translateCrossReferences(
				replacementContentText,
				classificationOverrides,
			);
			const replacementContent = {
				...operation.edit.content,
				text: replacementContentText,
			};
			const formatted = formatReplacementContent(
				replacementContent,
				range.indent ?? 0,
			);
			pushPatch({
				start: range.start,
				end: range.end,
				deleted: scopedText,
				inserted: formatted.text,
				insertedSuffixPlain: boundaryAwareReplacementSuffix(
					formatted,
					scopedText,
					plainText,
					range.end,
				),
			});
			break;
		}

		case UltimateEditKind.Strike: {
			if (!range) break;
			const strikeSearch = textSearchFromEditTarget(operation.edit.target);
			const strikingContent = strikeSearch?.text ?? null;
			const strikePunctuation =
				"punctuation" in operation.edit.target
					? operation.edit.target.punctuation
					: undefined;
			const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;
			const atEndSearch = strikeSearch?.atEnd === true;
			const throughContent = operation.edit.through
				? textFromEditTarget(operation.edit.through)
				: null;
			const throughPunctuation =
				operation.edit.through && "punctuation" in operation.edit.through
					? operation.edit.through.punctuation
					: undefined;

			if (!strikingContent && strikePunctuation && !throughContent) {
				const punctuation = punctuationText(strikePunctuation);
				const punctuationIndex = findPunctuationIndexAtEnd(
					scopedText,
					strikePunctuation,
				);
				attempt.searchText = punctuation;
				attempt.searchTextKind = "striking";
				attempt.searchIndex =
					punctuationIndex >= 0 ? range.start + punctuationIndex : null;
				if (punctuationIndex < 0) break;

				pushPatch({
					start: range.start + punctuationIndex,
					end: range.start + punctuationIndex + punctuation.length,
					deleted: punctuation,
				});
				break;
			}

			if (!strikingContent) {
				if (operation.structuralStrikeMode === "discrete") {
					if (operation.resolvedStructuralTargetIds.length === 0) break;
					if (
						operation.resolvedStructuralTargetIds.some(
							(value) => value === null,
						)
					) {
						break;
					}
					const targetRanges = operation.resolvedStructuralTargetIds
						.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
						.filter((resolved): resolved is ScopeRange => resolved !== null);
					if (
						targetRanges.length !== operation.resolvedStructuralTargetIds.length
					)
						break;
					targetRanges
						.sort((left, right) => right.start - left.start)
						.forEach((targetRange) => {
							pushPatch({
								start: targetRange.start,
								end: targetRange.end,
								deleted: plainText.slice(targetRange.start, targetRange.end),
							});
						});
					break;
				}
				if (operation.resolvedThroughTargetId) {
					const throughRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedThroughTargetId,
					);
					if (!throughRange) break;
					const sameTargetLevel =
						throughRange.indent !== undefined &&
						range.indent !== undefined &&
						throughRange.indent === range.indent;
					if (!sameTargetLevel) {
						pushPatch({
							start: range.start,
							end: range.end,
							deleted: scopedText,
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					pushPatch({
						start,
						end,
						deleted: plainText.slice(start, end),
					});
					break;
				}
				pushPatch({
					start: range.start,
					end: range.end,
					deleted: scopedText,
				});
				break;
			}

			let localStart =
				operation.atEndOnly || atEndSearch
					? scopedText.lastIndexOf(strikingContent)
					: scopedText.indexOf(strikingContent);
			let resolvedStrikingContent = strikingContent;

			if (
				localStart < 0 &&
				strikingContent &&
				!throughContent &&
				!throughPunctuation
			) {
				// We don't support fallback regex with "through" ranges right now as it's too complex to anchor
				const fallbackRegex = computeFallbackRegexSearch(
					strikingContent,
					classificationOverrides,
				);
				if (fallbackRegex) {
					const match = scopedText.match(fallbackRegex);
					if (match && match.index !== undefined && match.groups?.base) {
						localStart = match.index;
						resolvedStrikingContent = match[0];
						attempt.wasTranslated = true;
					}
				}
			}

			attempt.searchText = resolvedStrikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localStart >= 0 ? range.start + localStart : null;
			if (localStart < 0) break;

			if (eachPlaceItAppears && !throughContent && !throughPunctuation) {
				for (const occurrenceIndex of findAllOccurrences(
					scopedText,
					resolvedStrikingContent,
				)) {
					const patchRange = normalizeInlineDeletionRange(
						plainText,
						range.start + occurrenceIndex,
						range.start + occurrenceIndex + resolvedStrikingContent.length,
					);
					pushPatch({
						start: patchRange.start,
						end: patchRange.end,
						deleted: plainText.slice(patchRange.start, patchRange.end),
					});
				}
				break;
			}

			let localEnd = localStart + resolvedStrikingContent.length;
			if (throughContent) {
				const throughStart = scopedText.indexOf(
					throughContent,
					localStart + resolvedStrikingContent.length,
				);
				if (throughStart < 0) break;
				localEnd = throughStart + throughContent.length;
			}
			if (throughPunctuation) {
				const punctuation = punctuationText(throughPunctuation);
				const punctuationIndex = scopedText.indexOf(
					punctuation,
					localStart + resolvedStrikingContent.length,
				);
				if (punctuationIndex < 0) break;
				localEnd = punctuationIndex + punctuation.length;
			}

			let patchStart = range.start + localStart;
			let patchEnd = range.start + localEnd;
			if (throughContent || throughPunctuation) {
				const beforeChar = plainText[patchStart - 1] ?? "";
				const afterChar = plainText[patchEnd] ?? "";
				if (patchStart === 0 && afterChar === " ") {
					patchEnd += 1;
				} else if (patchStart > 0 && beforeChar === " " && afterChar === " ") {
					patchStart -= 1;
				}
			}
			const patchRange = normalizeInlineDeletionRange(
				plainText,
				patchStart,
				patchEnd,
			);

			pushPatch({
				start: patchRange.start,
				end: patchRange.end,
				deleted: plainText.slice(patchRange.start, patchRange.end),
			});
			break;
		}

		case UltimateEditKind.Insert: {
			if (!range) break;
			let contentText = operation.edit.content.text;
			contentText = translateCrossReferences(
				contentText,
				classificationOverrides,
			);
			const content = {
				...operation.edit.content,
				text: contentText,
			};

			if (operation.edit.before) {
				const anchor = textFromEditTarget(operation.edit.before);
				const translatedAnchor = anchor
					? translateCrossReferences(anchor, classificationOverrides)
					: null;
				let anchorStart: number | null = null;
				let resolvedAnchor: string | null = translatedAnchor;
				if (translatedAnchor) {
					let localIndex = scopedText.indexOf(translatedAnchor);
					if (localIndex < 0) {
						const ignoredTextMatch = findAnchorSearchMatch(
							scopedText,
							translatedAnchor,
							{
								ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
								ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
							},
						);
						if (ignoredTextMatch) {
							localIndex = ignoredTextMatch.index;
							resolvedAnchor = ignoredTextMatch.matchedText;
						}
					}
					if (localIndex < 0) {
						const fallback = computeFallbackAnchorRegexSearch(translatedAnchor);
						const fallbackMatch = fallback ? scopedText.match(fallback) : null;
						if (fallbackMatch && fallbackMatch.index !== undefined) {
							localIndex = fallbackMatch.index;
							resolvedAnchor = fallbackMatch[0];
						}
					}
					attempt.searchText = resolvedAnchor ?? translatedAnchor;
					attempt.searchTextKind = "anchor_before";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
					if (resolvedAnchor !== anchor) attempt.wasTranslated = true;
					if (localIndex >= 0) anchorStart = range.start + localIndex;
				} else if (operation.resolvedAnchorTargetId !== null) {
					const anchorRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedAnchorTargetId,
					);
					if (anchorRange) anchorStart = anchorRange.start;
				} else {
					const extracted = extractAnchor(operation.nodeText, "before");
					if (extracted) {
						const localIndex = scopedText.indexOf(extracted);
						attempt.searchText = extracted;
						attempt.searchTextKind = "anchor_before";
						attempt.searchIndex =
							localIndex >= 0 ? range.start + localIndex : null;
						if (localIndex >= 0) anchorStart = range.start + localIndex;
					}
				}
				if (anchorStart === null) break;
				const formatted = formatInsertionContent(content, range.indent ?? 0);
				const formattedText = formatted.text;
				const suffix = resolvedAnchor
					? /[A-Za-z0-9)]$/.test(formattedText) &&
						/^[A-Za-z0-9(]/.test(resolvedAnchor)
						? " "
						: ""
					: formattedText.endsWith("\n")
						? ""
						: "\n";
				pushPatch({
					start: anchorStart,
					end: anchorStart,
					deleted: "",
					inserted: formatted.text,
					insertedSuffixPlain: suffix,
				});
				break;
			}

			if (operation.edit.after) {
				const anchor = textFromEditTarget(operation.edit.after);
				const translatedAnchor = anchor
					? translateCrossReferences(anchor, classificationOverrides)
					: null;
				let anchorEnd: number | null = null;
				let resolvedAnchor: string | null = translatedAnchor;
				if (translatedAnchor) {
					let localIndex = scopedText.indexOf(translatedAnchor);
					if (localIndex < 0) {
						const ignoredTextMatch = findAnchorSearchMatch(
							scopedText,
							translatedAnchor,
							{
								ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
								ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
							},
						);
						if (ignoredTextMatch) {
							localIndex = ignoredTextMatch.index;
							resolvedAnchor = ignoredTextMatch.matchedText;
						}
					}
					if (localIndex < 0) {
						const fallback = computeFallbackAnchorRegexSearch(translatedAnchor);
						const fallbackMatch = fallback ? scopedText.match(fallback) : null;
						if (fallbackMatch && fallbackMatch.index !== undefined) {
							localIndex = fallbackMatch.index;
							resolvedAnchor = fallbackMatch[0];
						}
					}
					attempt.searchText = resolvedAnchor;
					attempt.searchTextKind = "anchor_after";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
					if (resolvedAnchor !== anchor) attempt.wasTranslated = true;
					if (localIndex >= 0)
						anchorEnd =
							range.start +
							localIndex +
							(resolvedAnchor ?? translatedAnchor).length;
				} else if (operation.resolvedAnchorTargetId !== null) {
					const anchorRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedAnchorTargetId,
					);
					if (anchorRange) anchorEnd = anchorRange.end;
				} else {
					const extracted = extractAnchor(operation.nodeText, "after");
					if (extracted) {
						const localIndex = scopedText.indexOf(extracted);
						attempt.searchText = extracted;
						attempt.searchTextKind = "anchor_after";
						attempt.searchIndex =
							localIndex >= 0 ? range.start + localIndex : null;
						if (localIndex >= 0)
							anchorEnd = range.start + localIndex + extracted.length;
					}
				}
				if (anchorEnd === null) break;
				const formatted = formatInsertionContent(content, range.indent ?? 0);
				const formattedText = formatted.text;
				const prefix = translatedAnchor
					? /[A-Za-z0-9)]$/.test(translatedAnchor) &&
						/^[A-Za-z0-9(]/.test(formattedText)
						? " "
						: ""
					: plainText[anchorEnd - 1] === "\n" || anchorEnd === 0
						? ""
						: "\n";
				pushPatch({
					start: anchorEnd,
					end: anchorEnd,
					deleted: "",
					inserted: formatted.text,
					insertedPrefixPlain: prefix,
				});
				break;
			}

			if (operation.addAtEnd) {
				const insertAt = range.end;
				const beforeChar = plainText[insertAt - 1] ?? "";
				const afterChar = plainText[insertAt] ?? "";
				const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
				const formatted = formatBlockInsertionContent(
					content,
					range.indent ?? 0,
				);
				const suffix = afterChar && afterChar !== "\n" ? "\n\n" : "\n";
				pushPatch({
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: formatted.text,
					insertedPrefixPlain: prefix,
					insertedSuffixPlain: suffix,
				});
				break;
			}

			// Plain insert at end of scope range
			const insertAt = range.end;
			const beforeChar = plainText[insertAt - 1] ?? "";
			const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
			const formatted = formatInsertionContent(content, range.indent ?? 0);
			pushPatch({
				start: insertAt,
				end: insertAt,
				deleted: "",
				inserted: formatted.text,
				insertedPrefixPlain: prefix,
			});
			break;
		}

		case UltimateEditKind.Redesignate: {
			if (!range) break;
			const mapping =
				operation.edit.mappings[operation.redesignateMappingIndex];
			if (!mapping) break;
			const fromLabel =
				mapping.from.path[mapping.from.path.length - 1]?.label ?? "";
			const toLabel = mapping.to.path[mapping.to.path.length - 1]?.label ?? "";
			const marker = `(${fromLabel})`;
			const replacement = `(${toLabel})`;
			const localIndex = scopedText.indexOf(marker);
			attempt.searchText = marker;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;
			pushPatch({
				start: range.start + localIndex,
				end: range.start + localIndex + marker.length,
				deleted: marker,
				inserted: replacement,
			});
			break;
		}

		case UltimateEditKind.Move: {
			if (operation.resolvedMoveFromIds.length !== operation.edit.from.length) {
				break;
			}
			if (operation.resolvedMoveFromIds.some((value) => value === null)) break;
			const fromRanges = operation.resolvedMoveFromIds
				.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
				.filter((resolved): resolved is ScopeRange => resolved !== null)
				.map((resolved) => ({ start: resolved.start, end: resolved.end }));
			if (fromRanges.length !== operation.edit.from.length) break;
			fromRanges.sort((left, right) => left.start - right.start);
			const movedBlock = fromRanges
				.map((resolved) => plainText.slice(resolved.start, resolved.end).trim())
				.join("\n");
			if (movedBlock.length === 0) break;
			if (operation.resolvedMoveAnchorId === null) break;
			const anchorRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedMoveAnchorId,
			);
			if (!anchorRange) break;
			const originalInsertIndex = operation.edit.before
				? anchorRange.start
				: anchorRange.end;
			let textWithoutMoved = plainText;
			for (let index = fromRanges.length - 1; index >= 0; index -= 1) {
				const segment = fromRanges[index];
				if (!segment) continue;
				textWithoutMoved = `${textWithoutMoved.slice(0, segment.start)}${textWithoutMoved.slice(segment.end)}`;
			}
			let adjustedInsertIndex = originalInsertIndex;
			for (const segment of fromRanges) {
				if (
					segment.start < originalInsertIndex &&
					originalInsertIndex < segment.end
				) {
					adjustedInsertIndex = -1;
					break;
				}
				if (segment.end <= originalInsertIndex) {
					adjustedInsertIndex -= segment.end - segment.start;
				}
			}
			if (adjustedInsertIndex < 0) break;
			const beforeChar = textWithoutMoved[adjustedInsertIndex - 1] ?? "";
			const afterChar = textWithoutMoved[adjustedInsertIndex] ?? "";
			const prefix =
				adjustedInsertIndex === 0 || beforeChar === "\n" ? "" : "\n";
			const suffix =
				adjustedInsertIndex >= textWithoutMoved.length || afterChar === "\n"
					? ""
					: "\n";
			const movedText = `${textWithoutMoved.slice(0, adjustedInsertIndex)}${prefix}${movedBlock}${suffix}${textWithoutMoved.slice(adjustedInsertIndex)}`;
			pushPatch({
				start: 0,
				end: plainText.length,
				deleted: plainText,
				inserted: movedText,
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

	const accepted: PlannedPatch[] = [];
	for (const patch of tentativePatches.sort(
		(left, right) =>
			left.operationIndex - right.operationIndex || left.start - right.start,
	)) {
		const hasConflict = accepted.some((existing) => overlaps(existing, patch));
		if (hasConflict) continue;
		accepted.push(patch);
	}

	const appliedCountByOperation = new Map<number, number>();
	for (const patch of accepted) {
		appliedCountByOperation.set(
			patch.operationIndex,
			(appliedCountByOperation.get(patch.operationIndex) ?? 0) + 1,
		);
	}
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		if (!attempt || attempt.outcome === "scope_unresolved") continue;
		const count = appliedCountByOperation.get(index) ?? 0;
		attempt.patchApplied = count > 0;
		attempt.outcome = count > 0 ? "applied" : "no_patch";
	}

	return {
		patches: accepted.sort(
			(left, right) =>
				left.operationIndex - right.operationIndex || left.start - right.start,
		),
		attempts,
	};
}
