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
	const deletionOnlyChanges = () =>
		props.effect.changes.filter(
			(change) => change.deleted.length > 0 && change.inserted.length === 0,
		);

	const getAbsoluteAttemptAnchorIndex = (
		attempt: (typeof props.effect.debug.operationAttempts)[number],
	): number | null => {
		const searchIndex = attempt.searchIndex;
		const scopeStart = attempt.scopedRange?.start;
		if (searchIndex === null || searchIndex === undefined) {
			return scopeStart ?? null;
		}
		if (scopeStart === undefined) return searchIndex;
		return scopeStart + searchIndex;
	};

	const resolveDeletionAnchorRanges = () => {
		const deletionAttempts = props.effect.debug.operationAttempts.filter(
			(attempt) =>
				attempt.outcome === "applied" && attempt.operationType === "delete",
		);
		const anchored = deletionOnlyChanges().map((change, index) => ({
			change,
			anchor: deletionAttempts[index]
				? getAbsoluteAttemptAnchorIndex(deletionAttempts[index])
				: null,
		}));
		const anchors = anchored.filter(
			(
				item,
			): item is {
				change: { deleted: string; inserted: string };
				anchor: number;
			} => item.anchor !== null,
		);
		return {
			resolved: anchors.map((item) => ({
				start: item.anchor,
				end: item.anchor,
				deletedText: item.change.deleted,
			})),
			resolvedCount: anchors.length,
			unresolved: anchored
				.filter((item) => item.anchor === null)
				.map((item) => item.change),
		};
	};

	const getOperationAnchorIndex = (
		insertions: ReturnType<typeof resolveInsertionRanges>,
	): number => {
		const operationAnchor = props.effect.debug.operationAttempts.find(
			(attempt) =>
				attempt.outcome === "applied" &&
				(attempt.searchIndex !== null || attempt.scopedRange !== null),
		);
		const operationSearchIndex = operationAnchor?.searchIndex;
		const operationScopeStart = operationAnchor?.scopedRange?.start;
		const operationAnchorIndex =
			operationSearchIndex === null || operationSearchIndex === undefined
				? operationScopeStart
				: operationScopeStart === undefined
					? operationSearchIndex
					: operationScopeStart + operationSearchIndex;
		return insertions[0]?.start ?? operationAnchorIndex ?? 0;
	};
	const hasUnappliedOperations = () =>
		props.effect.debug.operationAttempts.some(
			(attempt) => attempt.outcome !== "applied",
		);

	const hasUnresolvedInlineChanges = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) {
			return insertionChanges().length > 0 || deletionOnlyChanges().length > 0;
		}
		const insertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		);
		const deletionAnchors = resolveDeletionAnchorRanges();
		return (
			insertions.length < insertionChanges().length ||
			deletionAnchors.resolvedCount < deletionOnlyChanges().length
		);
	};

	const previewText = (text: string): string => {
		if (text.length <= FALLBACK_CHANGE_PREVIEW_CHARS) return text;
		return `${text.slice(0, FALLBACK_CHANGE_PREVIEW_CHARS)}...`;
	};

	const unresolvedDeletionOnlyChanges = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) return deletionOnlyChanges();
		const insertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		);
		const anchorIndex = getOperationAnchorIndex(insertions);
		const range = getSnippetRange(text, anchorIndex);
		const deletionAnchors = resolveDeletionAnchorRanges();
		const outOfRangeResolved = deletionAnchors.resolved
			.filter((item) => item.start < range.start || item.start > range.end)
			.map((item) => ({ deleted: item.deletedText, inserted: "" }));
		return [...deletionAnchors.unresolved, ...outOfRangeResolved];
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
		const anchorIndex = getOperationAnchorIndex(insertions);
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
		const deletionAnchors = resolveDeletionAnchorRanges();
		const localDeletions = deletionAnchors.resolved
			.filter((item) => item.start >= range.start && item.start <= range.end)
			.map((item) => ({
				start: item.start - range.start,
				end: item.start - range.start,
				deletedText: item.deletedText,
			}));

		const annotatedSnippet = injectInlineReplacements(
			snippet,
			[...localInsertions, ...localDeletions],
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
			{hasUnresolvedInlineChanges() ? (
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
					{unresolvedDeletionOnlyChanges().map((change) => (
						<p class="pdf-amended-snippet-replacement">
							<del class="pdf-amended-snippet-deleted">
								{previewText(change.deleted)}
							</del>
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}
