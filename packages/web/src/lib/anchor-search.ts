export interface AnchorSearchMatch {
	index: number;
	matchedText: string;
}

export interface AnchorSearchOptions {
	ignoreInHaystack?: RegExp;
	ignoreInNeedle?: RegExp;
}

interface ProjectedText {
	text: string;
	sourceIndexes: number[];
}

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
		getIgnoredSpans(haystack, options.ignoreInHaystack),
	);
	const projectedNeedle = projectText(
		needle,
		getIgnoredSpans(needle, options.ignoreInNeedle),
	);

	if (projectedNeedle.text.length === 0) return null;

	const projectedIndex = projectedHaystack.text.indexOf(projectedNeedle.text);
	if (projectedIndex < 0) return null;

	const start = projectedHaystack.sourceIndexes[projectedIndex];
	const lastProjectedIndex = projectedIndex + projectedNeedle.text.length - 1;
	const end = projectedHaystack.sourceIndexes[lastProjectedIndex] + 1;

	if (start === undefined || end === undefined) return null;

	return {
		index: start,
		matchedText: haystack.slice(start, end),
	};
}
