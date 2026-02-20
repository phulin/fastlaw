import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { assignIndentationLevels } from "./cluster-indentation";
import { splitParagraphsRulesBased } from "./rules-paragraph-condenser-3";
import type { Line, Paragraph } from "./types";
import { wordDictionary } from "./word-dictionary";

/* ===========================
 * Internal types
 * =========================== */

interface LineNumberColumnState {
	x: number;
	tolerance: number;
	confidence: number;
	seen: number;
	active: boolean;
}

interface TextStyleLike {
	fontFamily?: string;
	fontWeight?: string | number;
	fontStyle?: string;
}

type TextStylesByFontName = Record<string, TextStyleLike | undefined>;

/* ===========================
 * Utilities
 * =========================== */

function median(nums: number[]): number {
	const arr = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(arr.length / 2);
	return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function isNumeric(s: string): boolean {
	return /^\d{1,4}$/.test(s.trim());
}

function isWhitespaceOnly(s: string): boolean {
	return s.trim().length === 0;
}

function normalizeDoubleQuotes(s: string): string {
	return s
		.replaceAll("‘‘", "“")
		.replaceAll("″", "“")
		.replaceAll("’’", "”")
		.replace(/“$/, "”")
		.replaceAll("Representa-tives", "Representatives");
}

function normalizeMissingSpaceAfterClosingQuote(s: string): string {
	// Some PDF spans collapse the space after a closing double quote: ..."word”and...
	// Insert a single space when a closing double-quote is immediately followed by a word.
	return s.replaceAll(/([”"])([A-Za-z])/g, "$1 $2");
}

function normalizeLeadingLineNumberArtifact(s: string): string {
	return s
		.replace(/^\d{1,2}\s+(\d+\.\s)/, "$1")
		.replace(/^\d{1,2}\s+(\([a-z0-9,.]+\)[,;]?\s)/i, "$1")
		.replace(/^\d{1,2}\s+(The table of contents\b)/i, "$1");
}

function isTopCenteredPageNumberSpan(
	item: TextItem,
	pageWidth: number,
	pageHeight: number,
): boolean {
	if (!isNumeric(item.str)) return false;
	const x = item.transform[4];
	const y = item.transform[5];
	const itemCenter = x + item.width / 2;
	const pageCenter = pageWidth / 2;
	const centerTolerance = pageWidth * 0.08;
	return (
		Math.abs(itemCenter - pageCenter) <= centerTolerance &&
		y >= pageHeight * 0.9
	);
}

function isBottomNoteShortLine(line: Line, pageHeight: number): boolean {
	const text = line.text.trim();
	return !!text.match("[†•]") && text.length < 20 && line.y <= pageHeight * 0.1;
}

function isTextItem(item: unknown): item is TextItem {
	if (typeof item !== "object" || item === null) return false;
	const candidate = item as {
		str?: unknown;
		transform?: unknown;
		width?: unknown;
		height?: unknown;
	};
	return (
		typeof candidate.str === "string" &&
		Array.isArray(candidate.transform) &&
		typeof candidate.width === "number" &&
		typeof candidate.height === "number"
	);
}

function isBoldTextStyle(
	style: TextStyleLike | undefined,
	fontName: string | undefined,
): boolean {
	if (style) {
		if (typeof style.fontWeight === "number" && style.fontWeight >= 600) {
			return true;
		}
		if (
			typeof style.fontWeight === "string" &&
			/(bold|black|heavy|demi|semibold|[6-9]00)/i.test(style.fontWeight)
		) {
			return true;
		}
		if (
			typeof style.fontFamily === "string" &&
			/(bold|black|heavy|demi|semibold)/i.test(style.fontFamily)
		) {
			return true;
		}
	}
	if (!fontName) return false;
	return /(bold|black|heavy|demi|semibold|sb)/i.test(fontName);
}

/* ===========================
 * Extractor class
 * =========================== */

export class PdfLineExtractor {
	private lines: Line[] = [];

	private lineNumberColumn: LineNumberColumnState | null = null;

	/* ===========================
	 * Public API
	 * =========================== */

	ingestPage(
		pageNumber: number,
		items: TextItem[],
		pageWidth: number,
		pageHeight: number,
		textStyles: TextStylesByFontName = {},
	): void {
		const lines = this.detectLines(
			items,
			pageNumber,
			pageWidth,
			pageHeight,
			textStyles,
		);
		for (const rawLine of lines) {
			this.processLine(rawLine);
		}
	}

	getLines(): Line[] {
		return this.lines;
	}

	/* ===========================
	 * Core streaming logic
	 * =========================== */

	private processLine(rawLine: Line): void {
		this.lineNumberColumn = this.updateLineNumberColumn(
			this.lineNumberColumn,
			rawLine,
		);

		const strippedLine = this.stripLineNumberIfNeeded(
			this.lineNumberColumn,
			rawLine,
		);
		const line = {
			...strippedLine,
			text: normalizeLeadingLineNumberArtifact(strippedLine.text),
		};

		this.lines.push(line);
	}

	/* ===========================
	 * Line detection
	 * =========================== */

	private detectLines(
		items: TextItem[],
		pageNumber: number,
		pageWidth: number,
		pageHeight: number,
		textStyles: TextStylesByFontName,
	): Line[] {
		const enriched = items
			.filter(
				(item) => !isTopCenteredPageNumberSpan(item, pageWidth, pageHeight),
			)
			.filter((item) => !isWhitespaceOnly(item.str))
			.map((item) => ({
				item,
				x: item.transform[4],
				y: item.transform[5],
				w: item.width,
				h: item.height || 10,
				yStart: item.transform[5] + (item.height || 10), // PDF space is Y-up, so top is y + height
				yEnd: item.transform[5],
				style: textStyles[item.fontName],
			}));

		if (enriched.length === 0) return [];

		const yTolerance = median(enriched.map((e) => e.h)) * 0.45;

		enriched.sort((a, b) =>
			Math.abs(b.y - a.y) > yTolerance ? b.y - a.y : a.x - b.x,
		);

		const lines: Line[] = [];
		let current: typeof enriched = [];

		for (const e of enriched) {
			if (!current.length) {
				current.push(e);
				continue;
			}

			const prev = current[current.length - 1];
			if (Math.abs(prev.y - e.y) < yTolerance) {
				current.push(e);
			} else {
				lines.push(this.buildLine(current, pageNumber, pageHeight));
				current = [e];
			}
		}

		if (current.length) {
			lines.push(this.buildLine(current, pageNumber, pageHeight));
		}

		return lines.filter((line) => !isBottomNoteShortLine(line, pageHeight));
	}

	private buildLine(
		enriched: {
			item: TextItem;
			x: number;
			y: number;
			w: number;
			h: number;
			yStart: number;
			yEnd: number;
			style?: TextStyleLike;
		}[],
		page: number,
		pageHeight: number,
	): Line {
		enriched.sort((a, b) => a.x - b.x);

		let text = "";
		const lineHeight = median(enriched.map((e) => e.h));
		for (let i = 0; i < enriched.length; i++) {
			if (i > 0) {
				const gap = enriched[i].x - (enriched[i - 1].x + enriched[i - 1].w);
				if (gap > lineHeight * 0.24) text += " ";
			}
			text += enriched[i].item.str;
		}
		text = normalizeDoubleQuotes(text);
		text = normalizeMissingSpaceAfterClosingQuote(text);
		const boldItemCount = enriched.filter((entry) =>
			isBoldTextStyle(entry.style, entry.item.fontName),
		).length;
		const isBold = boldItemCount > enriched.length / 2;

		return {
			page,
			y: enriched[0].y,
			yStart: Math.max(...enriched.map((e) => e.yStart)),
			yEnd: Math.min(...enriched.map((e) => e.yEnd)),
			xStart: enriched[0].x,
			xEnd: enriched[enriched.length - 1].x + enriched[enriched.length - 1].w,
			text,
			items: enriched.map((e) => e.item),
			pageHeight,
			isBold,
		};
	}

	/* ===========================
	 * Line number column logic
	 * =========================== */

	private updateLineNumberColumn(
		state: LineNumberColumnState | null,
		line: Line,
	): LineNumberColumnState | null {
		const first = line.items[0];
		if (!first || !isNumeric(first.str)) {
			if (state?.active) {
				const confidence = state.confidence * 0.95;
				return { ...state, confidence, active: confidence > 0.4 };
			}
			return state;
		}

		const x = first.transform[4];
		const tolerance = first.width * 1.5;

		if (!state) {
			return {
				x,
				tolerance,
				seen: 1,
				confidence: 0.2,
				active: false,
			};
		}

		if (Math.abs(x - state.x) < state.tolerance) {
			const seen = state.seen + 1;
			const confidence = Math.min(1, state.confidence + 0.2);

			return {
				x: (state.x * state.seen + x) / seen,
				tolerance: Math.max(state.tolerance, tolerance),
				seen,
				confidence,
				active: confidence > 0.6,
			};
		}

		return state;
	}

	private stripLineNumberIfNeeded(
		state: LineNumberColumnState | null,
		line: Line,
	): Line {
		if (!state || !state.active) return line;

		const first = line.items[0];
		if (
			first &&
			isNumeric(first.str) &&
			Math.abs(first.transform[4] - state.x) < state.tolerance
		) {
			const rest = line.items.slice(1);
			return {
				...line,
				items: rest,
				text: line.text.replace(/^\d+\s*/, ""),
				xStart: rest.length ? rest[0].transform[4] : line.xStart,
			};
		}

		return line;
	}
}

export async function extractParagraphs(
	pdf: PDFDocumentProxy,
	options?: { startPage?: number; endPage?: number },
): Promise<Paragraph[]> {
	const startPage = Math.max(1, options?.startPage ?? 1);
	const endPage = Math.min(pdf.numPages, options?.endPage ?? pdf.numPages);
	const waitForAnimationFrame = () =>
		new Promise<void>((resolve) => {
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(() => resolve());
				return;
			}
			setTimeout(() => resolve(), 0);
		});
	const readPageTextContent = async (
		page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>,
	): Promise<{ items: TextItem[]; styles: TextStylesByFontName }> => {
		const textContent = await page.getTextContent();
		const items = textContent.items.filter(isTextItem);
		const styles = textContent.styles as TextStylesByFontName;
		return { items, styles };
	};

	const extractor = new PdfLineExtractor();

	for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
		if (pageNum % 25 === 0) await waitForAnimationFrame();
		const page = await pdf.getPage(pageNum);
		const { items, styles } = await readPageTextContent(page);
		const viewport = page.getViewport({ scale: 1 });
		extractor.ingestPage(
			pageNum,
			items,
			viewport.width,
			viewport.height,
			styles,
		);
	}

	const extractedLines = extractor.getLines();
	const condensedParagraphs = splitParagraphsRulesBased(extractedLines, {
		knownWords: wordDictionary,
	});

	const paragraphs: Paragraph[] = condensedParagraphs
		.map((paragraph) => {
			const lines = paragraph.lines;
			const firstLine = lines[0];
			if (!firstLine) return null;
			const boldLineCount = lines.filter((line) => line.isBold).length;
			return {
				startPage: paragraph.startPage,
				endPage: paragraph.endPage,
				text: paragraph.text,
				lines,
				confidence: 0.6,
				y: firstLine.y,
				yStart: firstLine.yStart,
				yEnd: firstLine.yEnd,
				pageHeight: firstLine.pageHeight,
				isBold: boldLineCount > lines.length / 2,
			};
		})
		.filter((paragraph): paragraph is Paragraph => paragraph !== null);

	return assignIndentationLevels(paragraphs);
}
