import type { AmendmentEffect } from "../lib/amendment-effects";
import { renderMarkdown } from "../lib/markdown";
import {
	injectInlineReplacements,
	resolveInsertionRanges,
} from "../lib/text-spans";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
	instructionHeader: string;
	instructionMarkdown: string;
}

function getFullSnippetRange(
	text: string,
	ranges: { start: number; end: number }[],
): {
	start: number;
	end: number;
} {
	if (text.length === 0) return { start: 0, end: 0 };
	if (ranges.length === 0) return { start: 0, end: text.length };

	let minStart = ranges[0].start;
	let maxEnd = ranges[0].end;
	for (const range of ranges.slice(1)) {
		if (range.start < minStart) minStart = range.start;
		if (range.end > maxEnd) maxEnd = range.end;
	}
	const startLineBreak = text.lastIndexOf("\n", Math.max(0, minStart - 1));
	const endLineBreak = text.indexOf("\n", Math.min(text.length, maxEnd));
	return {
		start: startLineBreak === -1 ? 0 : startLineBreak + 1,
		end: endLineBreak === -1 ? text.length : endLineBreak,
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

	const unresolvedDeletionOnlyChanges = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) return deletionOnlyChanges();
		const insertions = resolveInsertionRanges(text, [
			...insertionChanges().map((change) => change.inserted),
			...deletionOnlyChanges().map((change) => change.deleted),
		]);
		const range = getFullSnippetRange(text, insertions);
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

		const insertions = resolveInsertionRanges(text, [
			...insertionChanges().map((change) => change.inserted),
			...deletionOnlyChanges().map((change) => change.deleted),
		]);
		const range = getFullSnippetRange(text, insertions);
		const snippet = text.slice(range.start, range.end);
		const resolvedInsertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		).map((item, index) => ({
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
		return annotatedSnippet;
	};

	return (
		<div class="pdf-amended-snippet">
			<header class="pdf-amended-snippet-header">
				<h4>{props.instructionHeader}</h4>
			</header>
			<div
				class="pdf-amended-snippet-instruction markdown"
				innerHTML={renderMarkdown(props.instructionMarkdown)}
			/>
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
							<del class="pdf-amended-snippet-deleted">{change.deleted}</del>
							<ins class="pdf-amended-snippet-inserted">{change.inserted}</ins>
						</p>
					))}
					{unresolvedDeletionOnlyChanges().map((change) => (
						<p class="pdf-amended-snippet-replacement">
							<del class="pdf-amended-snippet-deleted">{change.deleted}</del>
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}
