import { renderAmendedSnippet } from "../lib/amended-snippet-render";
import type {
	AmendmentEffect,
	FailedApplyItem,
} from "../lib/amendment-edit-tree-apply";
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
	const humanTargetPath = (targetPath: string | null): string => {
		if (!targetPath) return "No explicit target path";
		const parts = targetPath.split(" > ").map((part) => {
			const [rawKind, rawValue] = part.split(":");
			const kind = (rawKind ?? "").trim().toLowerCase();
			const value = (rawValue ?? "").trim();
			if (!value) return part;
			switch (kind) {
				case "section":
					return `Section ${value}`;
				case "subsection":
					return `Subsection (${value})`;
				case "paragraph":
					return `Paragraph (${value})`;
				case "subparagraph":
					return `Subparagraph (${value})`;
				case "clause":
					return `Clause (${value})`;
				case "subclause":
					return `Subclause (${value})`;
				case "item":
					return `Item (${value})`;
				case "subitem":
					return `Subitem (${value})`;
				case "code_reference":
					return value;
				case "act_reference":
					return value;
				default:
					return `${kind} ${value}`;
			}
		});
		return parts.join(" \u203a ");
	};
	const scopeContext = (item: FailedApplyItem): string[] =>
		item.scopeContextTexts.filter(
			(value) =>
				value.trim().length > 0 && value.trim() !== item.originalText.trim(),
		);

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
							<div class="pdf-amended-snippet-replacement-label">
								Original text
							</div>
							<div
								class="pdf-amended-snippet-failed-original markdown"
								innerHTML={renderMarkdown(item.originalText)}
							/>
							{scopeContext(item).length > 0 ? (
								<>
									<div class="pdf-amended-snippet-replacement-label">Scope</div>
									<div class="pdf-amended-snippet-failed-scope markdown">
										{scopeContext(item).map((scopeText) => (
											<div
												class="pdf-amended-snippet-failed-scope-line"
												innerHTML={renderMarkdown(scopeText)}
											/>
										))}
									</div>
								</>
							) : null}
							<div class="pdf-amended-snippet-replacement-label">Target</div>
							<div class="pdf-amended-snippet-failed-target">
								{humanTargetPath(item.targetPath)}
							</div>
							<div class="pdf-amended-snippet-replacement-label">Reason</div>
							<div
								class="pdf-amended-snippet-failed-reason markdown"
								innerHTML={renderMarkdown(item.reason)}
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
