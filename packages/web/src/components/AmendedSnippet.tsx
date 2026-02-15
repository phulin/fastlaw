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
const FALLBACK_CHANGE_PREVIEW_CHARS = 900;

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
	const insertionChanges = () =>
		props.effect.changes.filter((change) => change.inserted.length > 0);
	const hasUnappliedOperations = () =>
		props.effect.debug.operationAttempts.some(
			(attempt) => attempt.outcome !== "applied",
		);

	const hasUnresolvedInlineInsertions = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) return insertionChanges().length > 0;
		const insertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		);
		return insertions.length < insertionChanges().length;
	};

	const previewText = (text: string): string => {
		if (text.length <= FALLBACK_CHANGE_PREVIEW_CHARS) return text;
		return `${text.slice(0, FALLBACK_CHANGE_PREVIEW_CHARS)}...`;
	};

	const highlightedSnippet = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) return "";

		const insertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		);
		const anchorIndex = insertions[0]?.start ?? 0;
		const range = getSnippetRange(text, anchorIndex);
		const snippet = text.slice(range.start, range.end);
		const resolvedInsertions = insertions.map((item, index) => ({
			...item,
			deletedText: insertionChanges()[index]?.deleted ?? "",
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
			{hasUnappliedOperations() ? (
				<div class="pdf-amended-snippet-status">
					<span class="pdf-amended-snippet-status-badge">
						Partially applied
					</span>
				</div>
			) : null}
			<div
				class="pdf-amended-snippet-main markdown"
				innerHTML={renderMarkdown(highlightedSnippet())}
			/>
			{hasUnresolvedInlineInsertions() ? (
				<div class="pdf-amended-snippet-replacements">
					{insertionChanges().map((change) => (
						<p class="pdf-amended-snippet-replacement">
							<del class="pdf-amended-snippet-deleted">
								{previewText(change.deleted)}
							</del>
							<ins class="pdf-amended-snippet-inserted">
								{previewText(change.inserted)}
							</ins>
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}
