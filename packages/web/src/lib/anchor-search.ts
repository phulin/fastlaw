export interface AnchorSearchMatch {
	index: number;
	matchedText: string;
}

export interface AnchorSearchOptions {
	ignoreInHaystack?: RegExp;
	ignoreInNeedle?: RegExp;
	caseInsensitive?: boolean;
}

interface ProjectedText {
	text: string;
	sourceIndexes: number[];
}

const PERIOD_BREAK_MARKER_RE =
	/(?<=\.)(?:[ \t]*(?:\u2014|_|\r?\n|\u2028|\u2029)[ \t]*)+/g;
const PERIOD_DASH_TOKEN_RE = /\.[ \t]*(?:\u2014|_)/g;

function toGlobalRegExp(pattern: RegExp): RegExp {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	return new RegExp(pattern.source, flags);
}

function getIgnoredSpans(
	text: string,
	pattern: RegExp | undefined,
): Array<{ start: number; end: number }> {
	if (!pattern) return [];
	const regex = toGlobalRegExp(pattern);
	const spans: Array<{ start: number; end: number }> = [];
	let match = regex.exec(text);
	while (match) {
		const start = match.index;
		const end = start + match[0].length;
		if (end > start) {
			spans.push({ start, end });
		} else {
			regex.lastIndex += 1;
		}
		match = regex.exec(text);
	}
	return spans;
}

function normalizeIgnoredSpans(
	spans: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	if (spans.length <= 1) return spans;
	const sorted = [...spans].sort((left, right) => left.start - right.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (!last || span.start > last.end) {
			merged.push({ start: span.start, end: span.end });
			continue;
		}
		last.end = Math.max(last.end, span.end);
	}
	return merged;
}

function projectText(
	text: string,
	ignoredSpans: Array<{ start: number; end: number }>,
): ProjectedText {
	if (ignoredSpans.length === 0) {
		return {
			text,
			sourceIndexes: Array.from(text, (_char, index) => index),
		};
	}

	let projected = "";
	const sourceIndexes: number[] = [];
	let cursor = 0;
	for (const span of ignoredSpans) {
		for (let index = cursor; index < span.start; index += 1) {
			projected += text[index];
			sourceIndexes.push(index);
		}
		cursor = span.end;
	}
	for (let index = cursor; index < text.length; index += 1) {
		projected += text[index];
		sourceIndexes.push(index);
	}
	return { text: projected, sourceIndexes };
}

export function findAnchorSearchMatch(
	haystack: string,
	needle: string,
	options: AnchorSearchOptions = {},
): AnchorSearchMatch | null {
	if (needle.length === 0) return null;

	const projectedHaystack = projectText(
		haystack,
		normalizeIgnoredSpans(
			[
				getIgnoredSpans(haystack, PERIOD_BREAK_MARKER_RE),
				getIgnoredSpans(haystack, options.ignoreInHaystack),
			].flat(),
		),
	);
	const projectedNeedle = projectText(
		needle,
		normalizeIgnoredSpans(
			[
				getIgnoredSpans(needle, PERIOD_BREAK_MARKER_RE),
				getIgnoredSpans(needle, options.ignoreInNeedle),
			].flat(),
		),
	);

	if (projectedNeedle.text.length === 0) return null;

	const projectedHaystackText = options.caseInsensitive
		? projectedHaystack.text.toLocaleLowerCase()
		: projectedHaystack.text;
	const projectedNeedleText = options.caseInsensitive
		? projectedNeedle.text.toLocaleLowerCase()
		: projectedNeedle.text;
	const projectedIndex = projectedHaystackText.indexOf(projectedNeedleText);
	if (projectedIndex < 0) {
		PERIOD_DASH_TOKEN_RE.lastIndex = 0;
		if (!PERIOD_DASH_TOKEN_RE.test(needle)) return null;
		PERIOD_DASH_TOKEN_RE.lastIndex = 0;
		const newlineNeedle = needle.replace(PERIOD_DASH_TOKEN_RE, "\n");
		const newlineMatch = findAnchorSearchMatch(
			haystack,
			newlineNeedle,
			options,
		);
		if (newlineMatch) return newlineMatch;
		const collapsedNeedle = needle.replace(PERIOD_DASH_TOKEN_RE, "");
		return findAnchorSearchMatch(haystack, collapsedNeedle, options);
	}

	const start = projectedHaystack.sourceIndexes[projectedIndex];
	const lastProjectedIndex = projectedIndex + projectedNeedle.text.length - 1;
	const end = projectedHaystack.sourceIndexes[lastProjectedIndex] + 1;

	if (start === undefined || end === undefined) return null;

	return {
		index: start,
		matchedText: haystack.slice(start, end),
	};
}
