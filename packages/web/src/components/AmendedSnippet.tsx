import { buildHighlightedSnippetMarkdown } from "../lib/amended-snippet-markdown";
import type { AmendmentEffect } from "../lib/amendment-edit-tree-apply";
import { renderMarkdown } from "../lib/markdown";
import { resolveInsertionRanges } from "../lib/text-spans";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
	instructionHeader: string;
	instructionMarkdown: string;
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
		if (typeof attempt.searchIndex === "number") {
			return attempt.searchIndex;
		}
		return attempt.scopedRange?.start ?? null;
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

	const resolvedInlineRanges = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		const text = unchanged?.text ?? "";
		if (!text) {
			return {
				text,
				insertions: [] as { start: number; end: number; deletedText: string }[],
				deletions: [] as { start: number; end: number; deletedText: string }[],
			};
		}
		const resolvedInsertions = resolveInsertionRanges(
			text,
			insertionChanges().map((change) => change.inserted),
		).map((item, index) => ({
			...item,
			deletedText: insertionChanges()[index]?.deleted ?? "",
		}));
		const deletionAnchors = resolveDeletionAnchorRanges();
		const resolvedDeletions = deletionAnchors.resolved.map((item) => ({
			start: item.start,
			end: item.end,
			deletedText: item.deletedText,
		}));
		return {
			text,
			insertions: resolvedInsertions,
			deletions: resolvedDeletions,
		};
	};

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
		const { text } = resolvedInlineRanges();
		if (!text) return deletionOnlyChanges();
		const snippetWindows = getContextWindows(
			text,
			[
				...resolveInsertionRanges(
					text,
					insertionChanges().map((change) => change.inserted),
				),
				...resolveInsertionRanges(
					text,
					deletionOnlyChanges().map((change) => change.deleted),
				),
			],
			5,
		);
		const deletionAnchors = resolveDeletionAnchorRanges();
		const outOfRangeResolved = deletionAnchors.resolved
			.filter(
				(item) =>
					!snippetWindows.some(
						(window) => item.start >= window.start && item.start < window.end,
					),
			)
			.map((item) => ({ deleted: item.deletedText, inserted: "" }));
		return [...deletionAnchors.unresolved, ...outOfRangeResolved];
	};

	const highlightedSnippet = () =>
		buildHighlightedSnippetMarkdown(props.effect);

	return (
		<div class="pdf-amended-snippet">
			<header class="pdf-amended-snippet-header">
				<h4>{props.instructionHeader}</h4>
				{hasUnappliedOperations() ? (
					<span class="pdf-amended-snippet-status-badge">
						Partially applied
					</span>
				) : null}
			</header>
			{hasUnappliedOperations() ? (
				<div
					class="pdf-amended-snippet-instruction markdown"
					innerHTML={renderMarkdown(props.instructionMarkdown)}
				/>
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
