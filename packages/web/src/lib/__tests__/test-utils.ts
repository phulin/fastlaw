import { expect } from "vitest";
import type { TextWithProvenance } from "../amendment-edit-tree";
import { type Line, type Paragraph, ParagraphRange } from "../types";

export function tp(text: string): TextWithProvenance {
	return { text, sourceLocation: new ParagraphRange([], 0, 0) };
}

export function createParagraph(
	text: string,
	options: Omit<Partial<Paragraph>, "lines"> & { lines?: Partial<Line>[] } = {},
): Paragraph {
	const xStart = options.lines?.[0]?.xStart ?? 0;
	const y = options.y ?? 100;
	const page = options.startPage ?? 1;

	const defaultLine: Line = {
		xStart,
		xEnd: xStart + Math.max(10, text.length * 3),
		y,
		yStart: y,
		yEnd: y + 10,
		text,
		items: [],
		page,
		pageHeight: 800,
		isBold: false,
	};

	const lines = (options.lines || [defaultLine]).map((l) => ({
		...defaultLine,
		...l,
	}));

	return {
		text,
		lines,
		startPage: page,
		endPage: page,
		confidence: 1,
		y,
		yStart: y,
		yEnd: y + 10,
		pageHeight: 800,
		isBold: false,
		...options,
	} as Paragraph;
}

export const parseFixtureParagraphs = (text: string): Paragraph[] => {
	const lines = text.split(/\r?\n/);
	const paragraphs: Paragraph[] = [];
	let page = 1;
	let y = 780;

	const indentFor = (value: string): number => {
		if (
			/^SEC\./.test(value) ||
			/^(TITLE|Subtitle|CHAPTER|SUBCHAPTER|PART)\b/.test(value)
		)
			return 0;
		if (/^\([a-z]+\)/.test(value)) return 24;
		if (/^\(\d+\)/.test(value)) return 40;
		if (/^\([A-Z]+\)/.test(value)) return 56;
		if (/^\(([ivx]+)\)/.test(value)) return 72;
		if (/^\(([IVX]+)\)/.test(value)) return 88;
		if (/^[“"]/.test(value)) return 104;
		return 8;
	};

	for (const rawLine of lines) {
		const pageMatch = rawLine.match(/^Page\s+(\d+)/);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			y = 780;
			continue;
		}

		if (!rawLine.startsWith("[*] ")) continue;
		const textValue = rawLine.slice(4).trim();
		if (!textValue) continue;

		const xStart = indentFor(textValue);
		paragraphs.push(
			createParagraph(textValue, {
				startPage: page,
				y,
				lines: [{ xStart, y, page }],
			}),
		);
		y -= 12;
		if (y < 40) y = 780;
	}

	return paragraphs;
};

type EditMarker = "~~" | "++";
type EditSpanType = "deletion" | "insertion";

interface ParsedMarkedSpan {
	type: EditSpanType;
	start: number;
	end: number;
	text: string;
}

interface ParsedMarkedText {
	plainText: string;
	spans: ParsedMarkedSpan[];
}

const MARKER_TO_SPAN_TYPE: Record<EditMarker, EditSpanType> = {
	"~~": "deletion",
	"++": "insertion",
};

function parseMarkedText(markedText: string): ParsedMarkedText {
	const spans: ParsedMarkedSpan[] = [];
	let plainText = "";
	let cursor = 0;

	while (cursor < markedText.length) {
		const maybeMarker = markedText.slice(cursor, cursor + 2);
		if (maybeMarker !== "~~" && maybeMarker !== "++") {
			plainText += markedText[cursor] ?? "";
			cursor += 1;
			continue;
		}

		const marker = maybeMarker as EditMarker;
		const endMarkerIndex = markedText.indexOf(marker, cursor + 2);
		if (endMarkerIndex < 0) {
			throw new Error(`Unclosed marker "${marker}" in: ${markedText}`);
		}

		const content = markedText.slice(cursor + 2, endMarkerIndex);
		const start = plainText.length;
		plainText += content;
		const end = plainText.length;
		spans.push({
			type: MARKER_TO_SPAN_TYPE[marker],
			start,
			end,
			text: content,
		});
		cursor = endMarkerIndex + 2;
	}

	return { plainText, spans };
}

type EffectLike = {
	renderModel: {
		plainText: string;
		spans: Array<{ type: string; start: number; end: number }>;
	};
};

function findAllOccurrences(haystack: string, needle: string): number[] {
	if (needle.length === 0) return [];
	const indexes: number[] = [];
	let cursor = 0;
	while (cursor <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index < 0) break;
		indexes.push(index);
		cursor = index + 1;
	}
	return indexes;
}

function hasMarkedEditSnippet(
	effect: EffectLike,
	markedSnippet: string,
): boolean {
	const parsed = parseMarkedText(markedSnippet);
	const occurrences = findAllOccurrences(
		effect.renderModel.plainText,
		parsed.plainText,
	);
	if (occurrences.length === 0) return false;

	for (const offset of occurrences) {
		const allSpansMatch = parsed.spans.every((expectedSpan) => {
			const expectedStart = offset + expectedSpan.start;
			const expectedEnd = offset + expectedSpan.end;
			return effect.renderModel.spans.some(
				(actualSpan) =>
					actualSpan.type === expectedSpan.type &&
					actualSpan.start <= expectedStart &&
					actualSpan.end >= expectedEnd,
			);
		});
		if (allSpansMatch) return true;
	}

	return false;
}

export function expectEffectToContainMarkedText(
	effect: EffectLike,
	markedSnippet: string,
): void {
	expect(hasMarkedEditSnippet(effect, markedSnippet)).toBe(true);
}
