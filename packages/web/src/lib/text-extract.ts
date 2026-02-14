import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { wordDictionary } from "./word-dictionary";

/* ===========================
 * Public types
 * =========================== */

export interface Line {
	page: number;
	y: number;
	xStart: number;
	xEnd: number;
	text: string;
	items: TextItem[];
}

export interface Paragraph {
	startPage: number;
	endPage: number;
	text: string;
	lines: Line[];
	confidence: number;
}

/* ===========================
 * Internal types
 * =========================== */

interface ParagraphBuilder {
	lines: Line[];
	text: string;
	startPage: number;
	lastLine: Line;
	confidence: number;
}

interface LineNumberColumnState {
	x: number;
	tolerance: number;
	confidence: number;
	seen: number;
	active: boolean;
}

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

function endsWithHyphen(s: string): boolean {
	return /-$/.test(s.trim());
}

function endsWithPunctuation(s: string): boolean {
	return /[.;:)\]]$/.test(s.trim());
}

function startsLowercase(s: string): boolean {
	return /^[a-z]/.test(s.trim());
}

function startsSectionMarker(s: string): boolean {
	return s.trim().toLowerCase().startsWith("sec.");
}

function isWhitespaceOnly(s: string): boolean {
	return s.trim().length === 0;
}

function startsDoubleOpeningQuote(s: string): boolean {
	return s.trimStart().startsWith("‘‘") || s.trimStart().startsWith('"');
}

function normalizeDoubleQuotes(s: string): string {
	return s.replaceAll("‘‘", '"').replaceAll("’’", '"');
}

function shouldDropTrailingHyphenWhenCoalescing(
	paragraphText: string,
	nextLineText: string,
): boolean {
	const leftMatch = paragraphText.trimEnd().match(/([a-z]+)-$/i);
	const rightMatch = nextLineText.trimStart().match(/^([a-z]+)/i);
	if (!leftMatch || !rightMatch) return false;

	const combinedWord = `${leftMatch[1]}${rightMatch[1]}`.toLowerCase();
	return wordDictionary.has(combinedWord);
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

function isBottomDaggerShortLine(line: Line, pageHeight: number): boolean {
	const text = line.text.trim();
	return text.includes("†") && text.length < 20 && line.y <= pageHeight * 0.1;
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

/* ===========================
 * Extractor class
 * =========================== */

export class PdfParagraphExtractor {
	private openParagraph: ParagraphBuilder | null = null;
	private paragraphs: Paragraph[] = [];
	private lastLine: Line | null = null;

	private lineNumberColumn: LineNumberColumnState | null = null;

	private recentGaps: number[] = [];
	private medianGap: number | null = null;

	/* ===========================
	 * Public API
	 * =========================== */

	ingestPage(
		pageNumber: number,
		items: TextItem[],
		pageWidth: number,
		pageHeight: number,
	): void {
		const lines = this.detectLines(items, pageNumber, pageWidth, pageHeight);
		for (const rawLine of lines) {
			this.processLine(rawLine);
		}
	}

	/**
	 * Final flush — closes any open paragraph.
	 * Call once at end of document.
	 */
	finish(): Paragraph[] {
		if (this.openParagraph) {
			this.paragraphs.push(this.finalizeParagraph(this.openParagraph));
			this.openParagraph = null;
		}
		return this.paragraphs;
	}

	/* ===========================
	 * Core streaming logic
	 * =========================== */

	private processLine(rawLine: Line): void {
		this.lineNumberColumn = this.updateLineNumberColumn(
			this.lineNumberColumn,
			rawLine,
		);

		const line = this.stripLineNumberIfNeeded(this.lineNumberColumn, rawLine);

		if (this.lastLine && this.lastLine.page === line.page) {
			this.recentGaps.push(this.lastLine.y - line.y);
			if (this.recentGaps.length > 20) this.recentGaps.shift();
			this.medianGap = median(this.recentGaps);
		}

		if (!this.openParagraph) {
			this.openParagraph = this.startParagraph(line);
			this.lastLine = line;
			return;
		}

		if (
			this.lastLine &&
			this.medianGap !== null &&
			this.shouldCloseParagraph(this.lastLine, line, this.medianGap)
		) {
			this.paragraphs.push(this.finalizeParagraph(this.openParagraph));
			this.openParagraph = this.startParagraph(line);
		} else {
			this.appendLine(this.openParagraph, line);
		}

		this.lastLine = line;
	}

	/* ===========================
	 * Line detection
	 * =========================== */

	private detectLines(
		items: TextItem[],
		pageNumber: number,
		pageWidth: number,
		pageHeight: number,
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
			}));

		if (enriched.length === 0) return [];

		const yTolerance = median(enriched.map((e) => e.h)) * 0.6;

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
				lines.push(this.buildLine(current, pageNumber));
				current = [e];
			}
		}

		if (current.length) {
			lines.push(this.buildLine(current, pageNumber));
		}

		return lines.filter((line) => !isBottomDaggerShortLine(line, pageHeight));
	}

	private buildLine(
		enriched: { item: TextItem; x: number; y: number; w: number; h: number }[],
		page: number,
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

		return {
			page,
			y: enriched[0].y,
			xStart: enriched[0].x,
			xEnd: enriched[enriched.length - 1].x + enriched[enriched.length - 1].w,
			text,
			items: enriched.map((e) => e.item),
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

	/* ===========================
	 * Paragraph logic
	 * =========================== */

	private shouldCloseParagraph(
		prev: Line,
		curr: Line,
		medianGap: number,
	): boolean {
		if (startsDoubleOpeningQuote(curr.text)) return true;
		if (startsSectionMarker(curr.text)) return true;
		if (endsWithHyphen(prev.text)) return false;

		const gap = prev.page === curr.page ? prev.y - curr.y : 0;

		const indentChange = Math.abs(curr.xStart - prev.xStart);

		if (gap > 2.25 * medianGap) return true;
		if (indentChange > 30 && endsWithPunctuation(prev.text)) return true;
		if (!endsWithPunctuation(prev.text)) return false;
		if (startsLowercase(curr.text)) return false;

		return false;
	}

	private startParagraph(line: Line): ParagraphBuilder {
		return {
			lines: [line],
			text: line.text,
			startPage: line.page,
			lastLine: line,
			confidence: 0.6,
		};
	}

	private appendLine(p: ParagraphBuilder, line: Line): void {
		if (endsWithHyphen(p.text)) {
			if (shouldDropTrailingHyphenWhenCoalescing(p.text, line.text)) {
				p.text = p.text.replace(/-$/, "");
			}
		} else if (!endsWithHyphen(p.text)) {
			p.text += " ";
		}
		p.text += line.text;
		p.lines.push(line);
		p.lastLine = line;
		p.confidence = Math.min(1, p.confidence + 0.1);
	}

	private finalizeParagraph(p: ParagraphBuilder): Paragraph {
		return {
			startPage: p.startPage,
			endPage: p.lastLine.page,
			text: p.text,
			lines: p.lines,
			confidence: p.confidence,
		};
	}
}

export async function extractParagraphs(
	pdf: PDFDocumentProxy,
): Promise<string[][]> {
	const waitForAnimationFrame = () =>
		new Promise<void>((resolve) => {
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(() => resolve());
				return;
			}
			setTimeout(() => resolve(), 0);
		});
	const readStreamTextItems = async (
		page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>,
	): Promise<TextItem[]> => {
		const reader = page.streamTextContent().getReader();
		const items: TextItem[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value as { items?: unknown[] } | undefined;
			if (!chunk?.items) continue;
			items.push(...chunk.items.filter(isTextItem));
		}
		return items;
	};

	const extractor = new PdfParagraphExtractor();
	const paragraphsByPage = Array.from(
		{ length: pdf.numPages },
		() => [] as string[],
	);

	for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
		if (pageNum % 25 === 0) await waitForAnimationFrame();
		const page = await pdf.getPage(pageNum);
		const textItems = await readStreamTextItems(page);
		const viewport = page.getViewport({ scale: 1 });
		extractor.ingestPage(pageNum, textItems, viewport.width, viewport.height);
	}

	for (const paragraph of extractor.finish()) {
		paragraphsByPage[paragraph.startPage - 1].push(paragraph.text);
	}

	return paragraphsByPage;
}
