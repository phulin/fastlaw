import type { Line, Paragraph } from "../text-extract";

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
