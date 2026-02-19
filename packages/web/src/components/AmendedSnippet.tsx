import type { AmendmentEffect } from "../lib/amendment-edit-tree-apply";
import { renderMarkdown } from "../lib/markdown";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
	instructionHeader: string;
	instructionMarkdown: string;
}

export function AmendedSnippet(props: AmendedSnippetProps) {
	const insertionChanges = () =>
		props.effect.changes.filter((change) => change.inserted.length > 0);
	const deletionOnlyChanges = () =>
		props.effect.changes.filter(
			(change) => change.deleted.length > 0 && change.inserted.length === 0,
		);
	const hasUnappliedOperations = () =>
		props.effect.debug.operationAttempts.some(
			(attempt) => attempt.outcome !== "applied",
		);
	const hasUnresolvedInlineChanges = () => {
		const expected = insertionChanges().length + deletionOnlyChanges().length;
		const resolved = props.effect.replacements?.length ?? 0;
		return resolved < expected;
	};

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
				innerHTML={props.effect.annotatedHtml ?? ""}
			/>
			{hasUnresolvedInlineChanges() ? (
				<div class="pdf-amended-snippet-replacements">
					<h5 class="pdf-amended-snippet-replacements-header">
						Unresolved changes
					</h5>
					{insertionChanges().map((change) => (
						<article class="pdf-amended-snippet-replacement">
							<div class="pdf-amended-snippet-replacement-label">Deleted</div>
							<div
								class="pdf-amended-snippet-deleted markdown"
								innerHTML={renderMarkdown(change.deleted)}
							/>
							<div class="pdf-amended-snippet-replacement-label">Inserted</div>
							<div
								class="pdf-amended-snippet-inserted markdown"
								innerHTML={renderMarkdown(change.inserted)}
							/>
						</article>
					))}
					{deletionOnlyChanges().map((change) => (
						<article class="pdf-amended-snippet-replacement">
							<div class="pdf-amended-snippet-replacement-label">Deleted</div>
							<div
								class="pdf-amended-snippet-deleted markdown"
								innerHTML={renderMarkdown(change.deleted)}
							/>
						</article>
					))}
				</div>
			) : null}
		</div>
	);
}
