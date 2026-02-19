export interface TextRange {
	start: number;
	end: number;
}

interface InjectInlineTagOptions {
	tagName: "ins" | "del" | "span";
	className?: string;
	addSpaceBeforeIfNeeded?: boolean;
}

interface InjectInlineReplacementOptions {
	insertedClassName?: string;
	deletedClassName?: string;
	addSpaceBeforeIfNeeded?: boolean;
}

function escapeMarkdownDelimiters(input: string): string {
	return input.replaceAll("~~", "\\~\\~").replaceAll("++", "\\+\\+");
}

function normalizeBlockText(input: string): string {
	return input.replace(/^\n+|\n+$/g, "");
}

function isFullLineRange(text: string, range: TextRange): boolean {
	if (range.end <= range.start) return false;
	const startsAtLineBoundary =
		range.start === 0 || text[range.start - 1] === "\n";
	const endsAtLineBoundary =
		range.end >= text.length || text[range.end] === "\n";
	return startsAtLineBoundary && endsAtLineBoundary;
}

function expandSingleLineBreaks(input: string): string {
	if (input.length === 0) return input;
	let output = "";
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (char !== "\n") {
			output += char;
			continue;
		}
		const prevChar = index > 0 ? input[index - 1] : "";
		const nextChar = index + 1 < input.length ? input[index + 1] : "";
		const isSingleBreak = prevChar !== "\n" && nextChar !== "\n";
		output += isSingleBreak ? "\n\n" : "\n";
	}
	return output;
}

export interface TextReplacementRange extends TextRange {
	deletedText: string;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
	return a.start < b.end && b.start < a.end;
}

function isAvailable(range: TextRange, used: TextRange[]): boolean {
	return used.every((candidate) => !rangesOverlap(range, candidate));
}

function findFirstAvailableMatch(
	text: string,
	needle: string,
	from: number,
	used: TextRange[],
): TextRange | null {
	let index = text.indexOf(needle, from);
	while (index !== -1) {
		const range = { start: index, end: index + needle.length };
		if (isAvailable(range, used)) {
			return range;
		}
		index = text.indexOf(needle, index + 1);
	}
	return null;
}

function candidateForms(value: string): string[] {
	const forms = [value, value.trim(), value.replace(/^\n+/, "").trimStart()];
	return Array.from(new Set(forms.filter((form) => form.length > 0)));
}

function findBestRange(
	text: string,
	candidates: string[],
	from: number,
	used: TextRange[],
): TextRange | null {
	let best: TextRange | null = null;
	for (const candidate of candidates) {
		const match = findFirstAvailableMatch(text, candidate, from, used);
		if (!match) continue;
		if (!best || match.start < best.start) {
			best = match;
		}
	}
	return best;
}

export function resolveInsertionRanges(
	text: string,
	insertedTexts: string[],
): TextRange[] {
	const used: TextRange[] = [];
	let cursor = 0;

	for (const insertedText of insertedTexts) {
		const candidates = candidateForms(insertedText);
		if (candidates.length === 0) continue;

		let range = findBestRange(text, candidates, cursor, used);
		if (!range) {
			range = findBestRange(text, candidates, 0, used);
		}
		if (!range) continue;

		used.push(range);
		used.sort((a, b) => a.start - b.start);
		cursor = range.end;
	}

	return used;
}

export function injectInlineTag(
	source: string,
	ranges: TextRange[],
	options: InjectInlineTagOptions,
): string {
	if (ranges.length === 0) return source;
	let result = source;
	const sorted = [...ranges].sort((a, b) => b.start - a.start);

	for (const range of sorted) {
		if (
			range.start < 0 ||
			range.end > result.length ||
			range.end < range.start
		) {
			continue;
		}

		const previousChar = range.start > 0 ? result[range.start - 1] : "";
		const needsLeadingSpace =
			options.addSpaceBeforeIfNeeded === true &&
			range.start > 0 &&
			previousChar.length > 0 &&
			!/\s/.test(previousChar);

		const classAttr = options.className ? ` class="${options.className}"` : "";
		const openingTag = `<${options.tagName}${classAttr}>`;
		const closingTag = `</${options.tagName}>`;
		const wrapped =
			`${needsLeadingSpace ? " " : ""}${openingTag}` +
			result.slice(range.start, range.end) +
			closingTag;

		result = result.slice(0, range.start) + wrapped + result.slice(range.end);
	}

	return result;
}

export function injectInlineReplacements(
	source: string,
	ranges: TextReplacementRange[],
	options: InjectInlineReplacementOptions,
): string {
	if (ranges.length === 0) return source;
	let result = source;
	const sorted = [...ranges].sort((a, b) => b.start - a.start);

	for (const range of sorted) {
		if (
			range.start < 0 ||
			range.end > result.length ||
			range.end < range.start
		) {
			continue;
		}

		const previousChar = range.start > 0 ? result[range.start - 1] : "";
		const nextChar = range.end < result.length ? result[range.end] : "";
		const needsLeadingSpace =
			options.addSpaceBeforeIfNeeded === true &&
			range.start > 0 &&
			previousChar.length > 0 &&
			!/\s/.test(previousChar);

		const insertedText = result.slice(range.start, range.end);
		const normalizedDeletedText = normalizeBlockText(range.deletedText);
		if (insertedText.length === 0 && normalizedDeletedText.length === 0) {
			continue;
		}
		const escapedDeletedText = escapeMarkdownDelimiters(normalizedDeletedText);
		const normalizedInsertedText = normalizeBlockText(insertedText);
		const isMultilineInsertion = insertedText.includes("\n");
		const isLineScoped = isFullLineRange(result, range);
		const markdownInsertedText = isMultilineInsertion
			? expandSingleLineBreaks(normalizedInsertedText)
			: normalizedInsertedText;
		const escapedInsertedText = escapeMarkdownDelimiters(markdownInsertedText);
		const isMultilineDeletion = normalizedDeletedText.includes("\n");
		const shouldUseBlockDelimiters =
			isMultilineInsertion || isMultilineDeletion || isLineScoped;
		const deletedInline = normalizedDeletedText
			? `~~${escapedDeletedText}~~`
			: "";
		const deletedBlock = normalizedDeletedText
			? `~~\n${escapedDeletedText}\n~~`
			: "";
		const wrapped =
			insertedText.length === 0
				? (() => {
						const prefix = needsLeadingSpace ? " " : "";
						const blockSuffix =
							range.end >= result.length || nextChar === "\n" ? "" : "\n\n";
						if (normalizedDeletedText.length === 0) return "";
						if (!shouldUseBlockDelimiters) {
							return `${prefix}${deletedInline}`;
						}
						return `${prefix}${deletedBlock}${blockSuffix}`;
					})()
				: shouldUseBlockDelimiters
					? (() => {
							const blockPrefix =
								range.start === 0 || previousChar === "\n" ? "" : "\n\n";
							const blockSuffix =
								range.end >= result.length || nextChar === "\n" ? "" : "\n\n";
							const deletedPrefix =
								normalizedDeletedText.length > 0 ? `${deletedBlock}\n\n` : "";
							const insertionPrefix =
								deletedPrefix.length > 0 ? "" : blockPrefix;
							return `${deletedPrefix}${insertionPrefix}++\n${escapedInsertedText}\n++${blockSuffix}`;
						})()
					: (() => {
							const prefix = needsLeadingSpace ? " " : "";
							const deletedPrefix =
								deletedInline.length > 0 ? `${deletedInline} ` : "";
							return `${prefix}${deletedPrefix}++${escapeMarkdownDelimiters(insertedText)}++`;
						})();

		result = result.slice(0, range.start) + wrapped + result.slice(range.end);
	}

	return result;
}
