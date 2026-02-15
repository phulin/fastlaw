import type { AmendmentEffect } from "../lib/amendment-effects";
import { renderMarkdown } from "../lib/markdown";
import {
	injectInlineReplacements,
	resolveInsertionRanges,
} from "../lib/text-spans";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
}

const CONTEXT_CHARS = 500;

function getSnippetRange(
	text: string,
	anchorIndex: number,
): {
	start: number;
	end: number;
} {
	const roughStart = Math.max(0, anchorIndex - CONTEXT_CHARS);
	const roughEnd = Math.min(text.length, anchorIndex + CONTEXT_CHARS);
	const start = text.lastIndexOf("\n", roughStart);
	const end = text.indexOf("\n", roughEnd);
	return {
		start: start === -1 ? 0 : start + 1,
		end: end === -1 ? text.length : end,
	};
}

export function AmendedSnippet(props: AmendedSnippetProps) {
	const highlightedSnippet = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) return "";

		const insertionChanges = props.effect.changes.filter(
			(change) => change.inserted.length > 0,
		);
		const insertions = resolveInsertionRanges(
			text,
			insertionChanges.map((change) => change.inserted),
		);
		const anchorIndex = insertions[0]?.start ?? 0;
		const range = getSnippetRange(text, anchorIndex);
		const snippet = text.slice(range.start, range.end);
		const resolvedInsertions = insertions.map((item, index) => ({
			...item,
			deletedText: insertionChanges[index]?.deleted ?? "",
		}));
		const localInsertions = resolvedInsertions
			.filter((item) => item.start < range.end && item.end > range.start)
			.map((item) => ({
				start: Math.max(0, item.start - range.start),
				end: Math.min(range.end - range.start, item.end - range.start),
				deletedText: item.deletedText,
			}))
			.filter((item) => item.end > item.start);

		const annotatedSnippet = injectInlineReplacements(
			snippet,
			localInsertions,
			{
				insertedClassName: "pdf-amended-snippet-inserted",
				deletedClassName: "pdf-amended-snippet-deleted",
				addSpaceBeforeIfNeeded: true,
			},
		);
		const prefix = range.start > 0 ? "...\n" : "";
		const suffix = range.end < text.length ? "\n..." : "";
		return `${prefix}${annotatedSnippet}${suffix}`;
	};

	return (
		<div class="pdf-amended-snippet">
			<div
				class="pdf-amended-snippet-main markdown"
				innerHTML={renderMarkdown(highlightedSnippet())}
			/>
		</div>
	);
}
