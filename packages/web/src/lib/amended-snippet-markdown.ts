import type { AmendmentEffect } from "./amendment-edit-tree-apply";

interface TextReplacementRange {
	start: number;
	end: number;
	deletedText: string;
}

interface TextParagraphRange {
	start: number;
	end: number;
}

function buildHtmlParagraphRanges(text: string): TextParagraphRange[] {
	const matches = [...text.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)];
	return matches
		.map((match) => {
			if (match.index === undefined) return null;
			return {
				start: match.index,
				end: match.index + match[0].length,
			};
		})
		.filter((range): range is TextParagraphRange => range !== null);
}

function buildMarkdownParagraphRanges(text: string): TextParagraphRange[] {
	const ranges: TextParagraphRange[] = [];
	let paragraphStart = 0;
	for (const match of text.matchAll(/\n\s*\n+/g)) {
		const splitStart = match.index;
		if (splitStart === undefined) continue;
		if (splitStart > paragraphStart) {
			ranges.push({ start: paragraphStart, end: splitStart });
		}
		paragraphStart = splitStart + match[0].length;
	}
	if (paragraphStart < text.length) {
		ranges.push({ start: paragraphStart, end: text.length });
	}
	return ranges;
}

function buildParagraphRanges(text: string): TextParagraphRange[] {
	if (text.length === 0) return [];
	const htmlRanges = buildHtmlParagraphRanges(text);
	if (htmlRanges.length > 0) return htmlRanges;
	const markdownRanges = buildMarkdownParagraphRanges(text);
	if (markdownRanges.length > 0) return markdownRanges;
	return [{ start: 0, end: text.length }];
}

function paragraphIndexForPosition(
	paragraphs: TextParagraphRange[],
	position: number,
): number {
	if (paragraphs.length === 0) return -1;
	const clampedPosition = Math.max(0, position);
	for (let index = 0; index < paragraphs.length; index += 1) {
		const paragraph = paragraphs[index];
		if (!paragraph) continue;
		if (clampedPosition >= paragraph.start && clampedPosition < paragraph.end) {
			return index;
		}
	}
	for (let index = 0; index < paragraphs.length; index += 1) {
		const paragraph = paragraphs[index];
		if (!paragraph) continue;
		if (clampedPosition < paragraph.start) return index;
	}
	return paragraphs.length - 1;
}

function getContextWindows(
	text: string,
	ranges: { start: number; end: number }[],
	contextParagraphs: number,
): { start: number; end: number }[] {
	if (text.length === 0) return [];
	if (ranges.length === 0) return [{ start: 0, end: text.length }];

	const paragraphs = buildParagraphRanges(text);
	if (paragraphs.length === 0) return [{ start: 0, end: text.length }];
	const paragraphWindows = ranges.map((range) => {
		const safeStart = Math.max(0, Math.min(range.start, text.length));
		const safeEnd = Math.max(safeStart, Math.min(range.end, text.length));
		const startParagraph = paragraphIndexForPosition(paragraphs, safeStart);
		const endPosition = safeEnd > safeStart ? safeEnd - 1 : safeStart;
		const endParagraph = paragraphIndexForPosition(paragraphs, endPosition);
		return {
			startParagraph: Math.max(0, startParagraph - contextParagraphs),
			endParagraph: Math.min(
				paragraphs.length - 1,
				endParagraph + contextParagraphs,
			),
		};
	});
	paragraphWindows.sort((a, b) => a.startParagraph - b.startParagraph);

	const mergedParagraphWindows: {
		startParagraph: number;
		endParagraph: number;
	}[] = [];
	for (const window of paragraphWindows) {
		const previous = mergedParagraphWindows[mergedParagraphWindows.length - 1];
		if (!previous || window.startParagraph > previous.endParagraph + 1) {
			mergedParagraphWindows.push(window);
			continue;
		}
		previous.endParagraph = Math.max(
			previous.endParagraph,
			window.endParagraph,
		);
	}

	return mergedParagraphWindows.map((window) => ({
		start: paragraphs[window.startParagraph]?.start ?? 0,
		end: paragraphs[window.endParagraph]?.end ?? text.length,
	}));
}

export interface HighlightedSnippetMarkdown {
	markdown: string;
	replacements: TextReplacementRange[];
}

export function buildHighlightedSnippetMarkdown(
	effect: AmendmentEffect,
	contextParagraphs = 5,
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
	const snippetWindows = getContextWindows(
		text,
		resolvedChanges,
		contextParagraphs,
	);

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
