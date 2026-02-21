import { renderAmendedSnippet } from "../lib/amended-snippet-render";
import type { AmendmentEffect } from "../lib/amendment-edit-tree-apply";
import { renderMarkdown } from "../lib/markdown";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
	instructionHeader: string;
}

export function AmendedSnippet(props: AmendedSnippetProps) {
	const highlightedSnippet = () => renderAmendedSnippet(props.effect);
	const failedItems = () => props.effect.applySummary.failedItems;
	const hasUnappliedOperations = () =>
		props.effect.applySummary.partiallyApplied;

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
				<div class="pdf-amended-snippet-replacements">
					<h5 class="pdf-amended-snippet-replacements-header">Failed items</h5>
					{failedItems().map((item) => (
						<article class="pdf-amended-snippet-replacement">
							<div class="pdf-amended-snippet-replacement-label">
								Item {item.operationIndex + 1}
							</div>
							<div
								class="pdf-amended-snippet-deleted markdown"
								innerHTML={renderMarkdown(item.text)}
							/>
							<div class="pdf-amended-snippet-replacement-label">Reason</div>
							<div
								class="pdf-amended-snippet-inserted markdown"
								innerHTML={renderMarkdown(
									item.reasonDetail
										? `${item.reason}\n\n${item.reasonDetail}`
										: item.reason,
								)}
							/>
						</article>
					))}
				</div>
			) : null}
			<div class="pdf-amended-snippet-main markdown">
				{highlightedSnippet()}
			</div>
		</div>
	);
}
