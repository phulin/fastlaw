import type { Line } from "./types";

export interface CondensedParagraph {
	startPage: number;
	endPage: number;
	text: string;
	lines: Line[];
}

export interface RulesParagraphCondenserOptions {
	knownWords?: ReadonlySet<string>;
}

interface MarkerInfo {
	raw: string;
	tokens: string[];
	isSection: boolean;
	isInnerHierarchy: boolean;
}

const INDENT_UPPER_BOUNDS = [171, 199, 227, 255, 283, 311] as const;
const STRUCTURAL_HEADER_RE =
	/^\s*["“‘]?(?:TITLE|Subtitle|SUBTITLE|CHAPTER|Subchapter|SUBCHAPTER|PART|SUBPART|DIVISION|BOOK)\b/;
const SECTION_HEADER_RE =
	/^\s*["“‘]?(?:Sec\.|SEC\.|§)\s+\d+[A-Za-z0-9().-]*\b|^\s*["“‘]?Section\s+\d+[A-Za-z0-9().-]*\.\s+[A-Z]/;
const DEFAULT_PAGE_WIDTH = 612;
const PAGE_CENTER_X = DEFAULT_PAGE_WIDTH / 2;
const CENTER_TOLERANCE = 24;

function percentile(values: number[], ratio: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.floor((sorted.length - 1) * ratio),
	);
	return sorted[index];
}

function startsStructuralHeader(text: string): boolean {
	const trimmed = text.trim();
	return STRUCTURAL_HEADER_RE.test(trimmed);
}

function startsSectionHeader(text: string): boolean {
	const trimmed = text.trim();
	return SECTION_HEADER_RE.test(trimmed);
}

function isCenteredOnPage(line: Line): boolean {
	const lineCenter = (line.xStart + line.xEnd) / 2;
	return Math.abs(lineCenter - PAGE_CENTER_X) <= CENTER_TOLERANCE;
}

function isShortLine(line: Line, xEndP75: number): boolean {
	return line.xEnd < xEndP75 - 8;
}

function indentationLevel(xStart: number): number {
	const idx = INDENT_UPPER_BOUNDS.findIndex((bound) => xStart < bound);
	return idx === -1 ? INDENT_UPPER_BOUNDS.length : idx;
}

function startsWithDoubleOpenQuote(text: string): boolean {
	return /^\s*(?:“|‘‘|")/.test(text);
}

function startsLowercase(text: string): boolean {
	return /^\s*[a-z]/.test(text);
}

function isMostlyUppercase(text: string): boolean {
	const letters = [...text].filter((char) => /[A-Za-z]/.test(char));
	const uppercaseCount = letters.filter((char) => /[A-Z]/.test(char)).length;
	if (letters.length < 6) return uppercaseCount === letters.length;
	return uppercaseCount / letters.length >= 0.85;
}

function endsWithHyphen(text: string): boolean {
	return /-\s*$/.test(text);
}

function endsWithPeriodOrSemicolon(text: string): boolean {
	return /([.;]|; and)\s*$/.test(text);
}

function endsWithColon(text: string): boolean {
	return /:\s*$/.test(text);
}

function hasLongPeriodRun(text: string): boolean {
	return /\.{10,}/.test(text);
}

function isWord(text: string, knownWords: ReadonlySet<string> | null): boolean {
	if (!knownWords) return false;
	return knownWords.has(text.toLowerCase());
}

function shouldDropTrailingHyphenWhenCoalescing(
	paragraphText: string,
	nextLineText: string,
	knownWords: ReadonlySet<string> | null,
): boolean {
	const leftMatch = paragraphText.trimEnd().match(/([a-zA-Z]+)-$/);
	const rightMatch = nextLineText.trimStart().match(/^([a-zA-Z]+)/);
	if (!leftMatch || !rightMatch) return false;

	const left = leftMatch[1].toLowerCase();
	const right = rightMatch[1].toLowerCase();
	const combined = `${left}${right}`;

	if (isWord(combined, knownWords)) return true;
	if (
		isWord(left, knownWords) &&
		isWord(right, knownWords) &&
		(left.length >= 3 || right.length >= 3)
	) {
		return false;
	}
	if (
		left === "inter" ||
		left === "infra" ||
		left === "intra" ||
		left === "sub"
	) {
		return true;
	}
	if (!isWord(left, knownWords)) return true;
	if (right.length <= 4) return true;
	return false;
}

function countOpenQuotes(text: string): number {
	return (text.match(/“|‘‘/g) ?? []).length;
}

function countCloseQuotes(text: string): number {
	return (text.match(/”|’’/g) ?? []).length;
}

function startsWithSectionMarker(text: string): boolean {
	return /^["“‘]?(?:SEC\.|Sec\.|§)\s+\d+/.test(text);
}

function parseMarker(text: string): MarkerInfo | null {
	const trimmed = text.trim();
	const isInnerHierarchy = /^["“‘]\(/.test(trimmed);
	if (startsWithSectionMarker(trimmed)) {
		const match = trimmed.match(/^["“‘]?(SEC\.|Sec\.|§)\s+(\d+)/);
		if (!match) return null;
		return {
			raw: match[0],
			tokens: [match[2]],
			isSection: true,
			isInnerHierarchy,
		};
	}

	// Inline quoted references like "(iii)", are not structural paragraph markers.
	if (/^["'“”‘’]?\([a-zA-Z0-9]+\)[”’"']/.test(trimmed)) {
		return null;
	}
	// Citation-leading parentheticals like "(28) of section ..." are references, not markers.
	if (
		/^["'“”‘’]?\([a-zA-Z0-9]+\)\s+of\s+(?:section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/i.test(
			trimmed,
		)
	) {
		return null;
	}

	const markerMatch = trimmed.match(/^["'“”‘’]?((?:\([a-zA-Z0-9]+\))+)/);
	if (!markerMatch) return null;
	const afterMarker = trimmed.slice(markerMatch[0].length);
	if (!/^[ ,]/.test(afterMarker)) return null;
	const markerTokens = Array.from(
		markerMatch[1].matchAll(/\(([a-zA-Z0-9]+)\)/g),
		(match) => match[1],
	);

	return {
		raw: markerMatch[0],
		tokens: markerTokens,
		isSection: false,
		isInnerHierarchy,
	};
}

function appendLine(
	currentText: string,
	nextText: string,
	knownWords: ReadonlySet<string> | null,
): string {
	if (endsWithHyphen(currentText)) {
		if (
			shouldDropTrailingHyphenWhenCoalescing(currentText, nextText, knownWords)
		) {
			return `${currentText.replace(/-\s*$/, "")}${nextText.trimStart()}`;
		}
		return `${currentText}${nextText.trimStart()}`;
	} else if (/[–—]\s*$/.test(currentText)) {
		return `${currentText}${nextText.trimStart()}`;
	}
	return `${currentText} ${nextText}`;
}

export function splitParagraphsRulesBased(
	lines: Line[],
	options: RulesParagraphCondenserOptions = {},
): CondensedParagraph[] {
	if (lines.length === 0) return [];
	const knownWords = options.knownWords ?? null;

	const xEndP75 = percentile(
		lines.map((line) => line.xEnd),
		0.75,
	);
	const paragraphs: CondensedParagraph[] = [];

	let currentLines: Line[] = [lines[0]];
	let currentText = lines[0].text;
	let quoteDepth = Math.max(
		0,
		countOpenQuotes(lines[0].text) - countCloseQuotes(lines[0].text),
	);

	for (let i = 1; i < lines.length; i += 1) {
		const previousLine = lines[i - 1];
		const currentLine = lines[i];

		const previousIndentLevel = indentationLevel(previousLine.xStart);
		const currentIndentLevel = indentationLevel(currentLine.xStart);
		const indentDelta = currentIndentLevel - previousIndentLevel;

		const currentParagraphFirstLine = currentLines[0];
		const currentParagraphIsStructuralHeader = startsStructuralHeader(
			currentParagraphFirstLine.text,
		);
		const currentParagraphIsSectionHeader = startsSectionHeader(
			currentParagraphFirstLine.text,
		);

		// const previousLineIsFirstLineOfParagraph = currentLines.length === 1;
		const previousLineIsNotFirstLineOfParagraph = currentLines.length >= 2;
		const currentLineWouldBeSecondLine = currentLines.length === 1;
		const currentLineWouldNotBeSecondLine = !currentLineWouldBeSecondLine;

		const lineQuoteDepth = Math.max(
			0,
			countOpenQuotes(currentLine.text) - countCloseQuotes(currentLine.text),
		);

		let shouldBreak = false;

		// Rule 1
		if (
			startsStructuralHeader(currentLine.text) &&
			isCenteredOnPage(currentLine)
		) {
			shouldBreak = true;
		} else if (startsSectionHeader(currentLine.text)) {
			shouldBreak = true;
		}
		// Rule 1.5
		else if (
			currentParagraphIsSectionHeader &&
			isMostlyUppercase(currentParagraphFirstLine.text) &&
			!isMostlyUppercase(currentLine.text)
		) {
			shouldBreak = true;
		}
		// Rule 1.6
		else if (
			hasLongPeriodRun(previousLine.text) ||
			hasLongPeriodRun(currentLine.text)
		) {
			shouldBreak = true;
		}
		// Rule 1.7
		else if (
			endsWithColon(previousLine.text) &&
			parseMarker(currentLine.text)?.isInnerHierarchy
		) {
			shouldBreak = true;
		}
		// Rule 2
		else if (
			isShortLine(previousLine, xEndP75) &&
			!currentParagraphIsStructuralHeader
		) {
			shouldBreak = true;
		}
		// Rule 3
		else if (
			indentDelta >= 1 &&
			!currentParagraphIsStructuralHeader &&
			!currentParagraphIsSectionHeader
		) {
			shouldBreak = true;
		}
		// Rule 4
		else if (indentDelta <= -2) {
			shouldBreak = true;
		}
		// Rule 5
		else if (
			indentDelta <= -1 &&
			previousLineIsNotFirstLineOfParagraph &&
			currentLineWouldNotBeSecondLine
		) {
			shouldBreak = true;
		}
		// Rule 7
		else if (
			quoteDepth >= 1 &&
			lineQuoteDepth >= 1 &&
			startsWithDoubleOpenQuote(currentParagraphFirstLine.text) &&
			startsWithDoubleOpenQuote(currentLine.text)
		) {
			shouldBreak = true;
		}
		// Rule 8
		else if (
			endsWithPeriodOrSemicolon(previousLine.text) &&
			parseMarker(currentLine.text)
		) {
			shouldBreak = true;
		}
		// Rule 9
		else if (
			startsLowercase(currentLine.text) ||
			endsWithHyphen(previousLine.text)
		) {
			shouldBreak = false;
		}
		// Rule 10
		else {
			shouldBreak = false;
		}

		if (shouldBreak) {
			paragraphs.push({
				startPage: currentLines[0].page,
				endPage: currentLines[currentLines.length - 1].page,
				text: currentText.trim(),
				lines: currentLines,
			});
			currentLines = [currentLine];
			currentText = currentLine.text;
			quoteDepth = Math.max(
				0,
				countOpenQuotes(currentLine.text) - countCloseQuotes(currentLine.text),
			);
			continue;
		}

		currentText = appendLine(currentText, currentLine.text, knownWords);
		currentLines.push(currentLine);
		quoteDepth += lineQuoteDepth;
	}

	paragraphs.push({
		startPage: currentLines[0].page,
		endPage: currentLines[currentLines.length - 1].page,
		text: currentText.trim(),
		lines: currentLines,
	});

	return paragraphs;
}

export function formatCondensedParagraphs(
	paragraphs: CondensedParagraph[],
): string {
	return `${paragraphs
		.map(
			(paragraph) =>
				`(p${paragraph.startPage}-${paragraph.endPage}) ${paragraph.text}`,
		)
		.join("\n")}\n`;
}
