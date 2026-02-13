import type { TextItem } from "pdfjs-dist/types/src/display/api";

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
	pageStart: number;
	pageEnd: number;
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
	pageStart: number;
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

const HYPHEN_PREFIXES = [
	"non",
	"anti",
	"pre",
	"post",
	"self",
	"quasi",
	"co",
	"sub",
	"inter",
	"intra",
	"multi",
	"pseudo",
	"cross",
	"counter",
	"ex",
	"ultra",
	"infra",
	"macro",
	"micro",
] as const;

const protectedHyphenPrefixes = new Set(
	HYPHEN_PREFIXES.map((prefix) => `${prefix}-`),
);

function shouldPreserveTrailingHyphen(s: string): boolean {
	const match = s
		.trim()
		.toLowerCase()
		.match(/([a-z]+-)$/);
	if (!match) return false;
	return protectedHyphenPrefixes.has(match[1]);
}

function endsWithPunctuation(s: string): boolean {
	return /[.;:)\]]$/.test(s.trim());
}

function startsLowercase(s: string): boolean {
	return /^[a-z]/.test(s.trim());
}

function startsSectionMarker(s: string): boolean {
	return s.trim().startsWith("Sec.");
}

function isWhitespaceOnly(s: string): boolean {
	return s.trim().length === 0;
}

function startsDoubleOpeningQuote(s: string): boolean {
	return s.trimStart().startsWith("‘‘");
}

function normalizeDoubleOpeningQuotes(s: string): string {
	return s.replaceAll("‘‘", '"');
}

/* ===========================
 * Extractor class
 * =========================== */

export class PdfParagraphExtractor {
	private openParagraph: ParagraphBuilder | null = null;
	private lastLine: Line | null = null;

	private lineNumberColumn: LineNumberColumnState | null = null;

	private recentGaps: number[] = [];
	private medianGap: number | null = null;

	/** NEW: buffer of closed paragraphs ready to be consumed */
	private closedQueue: Paragraph[] = [];

	/* ===========================
	 * Public API
	 * =========================== */

	ingestPage(pageNumber: number, items: TextItem[]): void {
		const lines = this.detectLines(items, pageNumber);
		for (const rawLine of lines) {
			this.processLine(rawLine);
		}
	}

	/**
	 * NEW: Return paragraphs that have been closed since last call.
	 * Safe to call after each page or render tick.
	 */
	drainClosedParagraphs(): Paragraph[] {
		const out = this.closedQueue;
		this.closedQueue = [];
		return out;
	}

	/**
	 * Final flush — closes any open paragraph.
	 * Call once at end of document.
	 */
	finish(): Paragraph[] {
		if (this.openParagraph) {
			this.closedQueue.push(this.finalizeParagraph(this.openParagraph));
			this.openParagraph = null;
		}
		return this.drainClosedParagraphs();
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
			// NEW: emit closed paragraph immediately
			this.closedQueue.push(this.finalizeParagraph(this.openParagraph));
			this.openParagraph = this.startParagraph(line);
		} else {
			this.appendLine(this.openParagraph, line);
		}

		this.lastLine = line;
	}

	/* ===========================
	 * Line detection
	 * =========================== */

	private detectLines(items: TextItem[], pageNumber: number): Line[] {
		const enriched = items
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

		return lines;
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
				if (gap > lineHeight * 0.28) text += " ";
			}
			text += enriched[i].item.str;
		}
		text = normalizeDoubleOpeningQuotes(text);

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

		const gap = prev.page === curr.page ? prev.y - curr.y : Infinity;

		const indentChange = Math.abs(curr.xStart - prev.xStart);

		if (gap > 1.6 * medianGap) return true;
		if (indentChange > 15) return true;

		if (!endsWithPunctuation(prev.text) && startsLowercase(curr.text))
			return false;

		if (endsWithHyphen(prev.text)) return false;

		return false;
	}

	private startParagraph(line: Line): ParagraphBuilder {
		return {
			lines: [line],
			text: line.text,
			pageStart: line.page,
			lastLine: line,
			confidence: 0.6,
		};
	}

	private appendLine(p: ParagraphBuilder, line: Line): void {
		if (endsWithHyphen(p.text) && !shouldPreserveTrailingHyphen(p.text)) {
			p.text = p.text.replace(/-$/, "");
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
			pageStart: p.pageStart,
			pageEnd: p.lastLine.page,
			text: p.text,
			lines: p.lines,
			confidence: p.confidence,
		};
	}
}
