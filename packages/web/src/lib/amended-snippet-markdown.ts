import type { AmendmentEffect } from "./amendment-edit-tree-apply";

interface TextReplacementRange {
	start: number;
	end: number;
	deletedText: string;
}

function lineStartsForText(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") {
			starts.push(index + 1);
		}
	}
	return starts;
}

function lineIndexForPosition(lineStarts: number[], position: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (lineStarts[mid] <= position) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(0, high);
}

function getContextWindows(
	text: string,
	ranges: { start: number; end: number }[],
	contextLines: number,
): { start: number; end: number }[] {
	if (text.length === 0) return [];
	if (ranges.length === 0) return [{ start: 0, end: text.length }];

	const starts = lineStartsForText(text);
	const lastLineIndex = starts.length - 1;
	const lineWindows = ranges.map((range) => {
		const safeStart = Math.max(0, Math.min(range.start, text.length));
		const safeEnd = Math.max(safeStart, Math.min(range.end, text.length));
		const startLine = lineIndexForPosition(starts, safeStart);
		const endPosition =
			safeEnd > safeStart ? Math.max(0, safeEnd - 1) : safeStart;
		const endLine = lineIndexForPosition(starts, endPosition);
		return {
			startLine: Math.max(0, startLine - contextLines),
			endLine: Math.min(lastLineIndex, endLine + contextLines),
		};
	});
	lineWindows.sort((a, b) => a.startLine - b.startLine);

	const mergedLineWindows: { startLine: number; endLine: number }[] = [];
	for (const window of lineWindows) {
		const previous = mergedLineWindows[mergedLineWindows.length - 1];
		if (!previous || window.startLine > previous.endLine + 1) {
			mergedLineWindows.push(window);
			continue;
		}
		previous.endLine = Math.max(previous.endLine, window.endLine);
	}

	return mergedLineWindows.map((window) => ({
		start: starts[window.startLine],
		end:
			window.endLine + 1 < starts.length
				? starts[window.endLine + 1]
				: text.length,
	}));
}

export interface HighlightedSnippetMarkdown {
	markdown: string;
	replacements: TextReplacementRange[];
}

export function buildHighlightedSnippetMarkdown(
	effect: AmendmentEffect,
	contextLines = 5,
): HighlightedSnippetMarkdown {
	const unchanged = effect.segments.find(
		(segment) => segment.kind === "unchanged",
	);
	const text = unchanged?.text ?? "";
	if (!text) {
		return {
			markdown: "",
			replacements: [],
		};
	}
	const resolvedChanges = effect.replacements ?? [];
	const snippetWindows = getContextWindows(text, resolvedChanges, contextLines);

	const snippets = snippetWindows.map((window) => {
		const snippet = text.slice(window.start, window.end);
		const localChanges = resolvedChanges
			.filter((item) => item.start < window.end && item.end >= window.start)
			.map((item) => ({
				start: Math.max(0, item.start - window.start),
				end: Math.max(0, Math.min(window.end, item.end) - window.start),
				deletedText: item.deletedText,
			}));
		return {
			markdown: snippet,
			replacements: localChanges,
		};
	});

	if (snippets.length === 0) {
		return {
			markdown: text,
			replacements: [],
		};
	}

	if (snippets.length === 1) {
		return snippets[0];
	}

	const joinedMarkdown = snippets
		.map((item) => item.markdown)
		.join("\n\n...\n\n");
	const joinedReplacements: TextReplacementRange[] = [];
	let cursor = 0;
	for (let index = 0; index < snippets.length; index += 1) {
		const snippet = snippets[index];
		for (const replacement of snippet.replacements) {
			joinedReplacements.push({
				start: replacement.start + cursor,
				end: replacement.end + cursor,
				deletedText: replacement.deletedText,
			});
		}
		cursor += snippet.markdown.length;
		if (index < snippets.length - 1) {
			cursor += "\n\n...\n\n".length;
		}
	}

	return {
		markdown: joinedMarkdown,
		replacements: joinedReplacements,
	};
}
