export interface TextRange {
	start: number;
	end: number;
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
