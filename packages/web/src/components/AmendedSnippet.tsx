import type { AmendmentEffect } from "../lib/amendment-effects";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
}

const MAX_SNIPPET_CHARS = 800;

function truncate(text: string): string {
	if (text.length <= MAX_SNIPPET_CHARS) return text;
	return `${text.slice(0, MAX_SNIPPET_CHARS)}...`;
}

export function AmendedSnippet(props: AmendedSnippetProps) {
	const mainText = () => {
		const unchanged = props.effect.segments.find(
			(segment) => segment.kind === "unchanged",
		);
		return truncate(unchanged?.text ?? "");
	};

	return (
		<div class="pdf-amended-snippet">
			<p class="pdf-amended-snippet-main">{mainText()}</p>
			{props.effect.deleted.length > 0 ? (
				<div class="pdf-amended-snippet-delta">
					<p class="pdf-amended-snippet-label">Deleted</p>
					{props.effect.deleted.map((text) => (
						<p class="pdf-amended-snippet-deleted">{text}</p>
					))}
				</div>
			) : null}
			{props.effect.inserted.length > 0 ? (
				<div class="pdf-amended-snippet-delta">
					<p class="pdf-amended-snippet-label">Inserted</p>
					{props.effect.inserted.map((text) => (
						<p class="pdf-amended-snippet-inserted">{text}</p>
					))}
				</div>
			) : null}
		</div>
	);
}
