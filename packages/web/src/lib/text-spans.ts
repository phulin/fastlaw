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

export interface TextReplacementRange extends TextRange {
	deletedText: string;
}

function escapeHtml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
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
			range.end <= range.start
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
			range.end <= range.start
		) {
			continue;
		}

		const previousChar = range.start > 0 ? result[range.start - 1] : "";
		const needsLeadingSpace =
			options.addSpaceBeforeIfNeeded === true &&
			range.start > 0 &&
			previousChar.length > 0 &&
			!/\s/.test(previousChar);

		const insertedClass = options.insertedClassName
			? ` class="${options.insertedClassName}"`
			: "";
		const deletedClass = options.deletedClassName
			? ` class="${options.deletedClassName}"`
			: "";
		const insertedText = result.slice(range.start, range.end);
		const isMultilineInsertion = insertedText.includes("\n");
		const deletedPrefix = range.deletedText
			? `<del${deletedClass}>${escapeHtml(range.deletedText)}</del> `
			: "";
		const wrapped = isMultilineInsertion
			? (() => {
					const body = insertedText.replace(/^\n+|\n+$/g, "");
					return (
						`\n\n${deletedPrefix}<ins${insertedClass}>\n` +
						body +
						"\n</ins>\n\n"
					);
				})()
			: `${needsLeadingSpace ? " " : ""}${deletedPrefix}<ins${insertedClass}>${insertedText}</ins>`;

		result = result.slice(0, range.start) + wrapped + result.slice(range.end);
	}

	return result;
}
