import type { JSX } from "solid-js";
import type { FormattingSpan } from "./amendment-edit-engine-types";
import type { AmendmentEffect } from "./amendment-edit-tree-apply";

function headingDepthForParagraph(
	paragraph: FormattingSpan,
	spans: FormattingSpan[],
): number | null {
	for (const span of spans) {
		if (span.type !== "heading") continue;
		if (span.start > paragraph.start || span.end < paragraph.end) continue;
		const depth = span.metadata?.depth;
		if (typeof depth === "number" && Number.isFinite(depth)) {
			return Math.max(1, Math.floor(depth));
		}
	}
	return null;
}

function getQuoteDepthForParagraph(
	paragraph: FormattingSpan,
	spans: FormattingSpan[],
): number {
	const explicitDepth = paragraph.metadata?.quoteDepth;
	if (typeof explicitDepth === "number" && Number.isFinite(explicitDepth)) {
		return explicitDepth;
	}
	let maxDepth = 0;
	for (const span of spans) {
		if (span.type !== "blockquote") continue;
		if (span.start > paragraph.start || span.end < paragraph.end) continue;
		const depth = span.metadata?.depth;
		if (typeof depth === "number" && depth > maxDepth) {
			maxDepth = depth;
		}
	}
	return maxDepth;
}

function inlinePriority(type: FormattingSpan["type"]): number {
	switch (type) {
		case "link":
			return 0;
		case "strong":
			return 1;
		case "emphasis":
			return 2;
		case "delete":
		case "deletion":
			return 3;
		case "insertion":
			return 4;
		case "inlineCode":
			return 5;
		default:
			return 10;
	}
}

function isInlineSpan(span: FormattingSpan): boolean {
	switch (span.type) {
		case "strong":
		case "emphasis":
		case "delete":
		case "deletion":
		case "insertion":
		case "inlineCode":
		case "link":
			return true;
		default:
			return false;
	}
}

function renderTextWithBreaks(value: string): JSX.Element {
	const lines = value.split("\n");
	if (lines.length === 1) return value;
	return (
		<>
			{lines.map((line, index) => (
				<>
					{index > 0 ? <br /> : null}
					{line}
				</>
			))}
		</>
	);
}

function wrapInline(span: FormattingSpan, child: JSX.Element): JSX.Element {
	switch (span.type) {
		case "strong":
			return <strong>{child}</strong>;
		case "emphasis":
			return <em>{child}</em>;
		case "delete":
		case "deletion":
			return <del>{child}</del>;
		case "insertion":
			return <ins>{child}</ins>;
		case "inlineCode":
			return <code>{child}</code>;
		case "link": {
			const href = span.metadata?.href;
			if (typeof href === "string" && href.length > 0) {
				return <a href={href}>{child}</a>;
			}
			return child;
		}
		default:
			return child;
	}
}

function renderParagraphContent(
	paragraph: FormattingSpan,
	plainText: string,
	spans: FormattingSpan[],
): JSX.Element {
	const paragraphText = plainText.slice(paragraph.start, paragraph.end);
	const paragraphSpans = spans.filter(
		(span) =>
			isInlineSpan(span) &&
			span.start >= paragraph.start &&
			span.end <= paragraph.end &&
			span.end > span.start,
	);
	const boundaries = new Set<number>([0, paragraphText.length]);
	for (const span of paragraphSpans) {
		boundaries.add(span.start - paragraph.start);
		boundaries.add(span.end - paragraph.start);
	}
	const sorted = [...boundaries].sort((left, right) => left - right);
	const pieces: JSX.Element[] = [];

	for (let index = 0; index < sorted.length - 1; index += 1) {
		const localStart = sorted[index] ?? 0;
		const localEnd = sorted[index + 1] ?? localStart;
		if (localEnd <= localStart) continue;
		const segmentText = paragraphText.slice(localStart, localEnd);
		if (segmentText.length === 0) continue;
		const globalStart = paragraph.start + localStart;
		const globalEnd = paragraph.start + localEnd;
		const activeSpans = paragraphSpans
			.filter((span) => span.start <= globalStart && span.end >= globalEnd)
			.sort(
				(left, right) =>
					inlinePriority(left.type) - inlinePriority(right.type) ||
					left.start - right.start ||
					right.end - left.end,
			);
		const wrapped = activeSpans.reduceRight(
			(content, span) => wrapInline(span, content),
			renderTextWithBreaks(segmentText),
		);
		pieces.push(wrapped);
	}

	return <>{pieces}</>;
}

function renderParagraphBlock(
	paragraph: FormattingSpan,
	plainText: string,
	spans: FormattingSpan[],
): JSX.Element {
	const content = renderParagraphContent(paragraph, plainText, spans);
	const quoteDepth = Math.max(
		0,
		Math.min(5, getQuoteDepthForParagraph(paragraph, spans)),
	);
	const className = quoteDepth > 0 ? `indent${quoteDepth}` : undefined;
	const headingDepth = headingDepthForParagraph(paragraph, spans);
	const clampedHeadingDepth =
		headingDepth === null ? null : Math.max(1, Math.min(6, headingDepth));

	switch (clampedHeadingDepth) {
		case 1:
			return <h1 class={className}>{content}</h1>;
		case 2:
			return <h2 class={className}>{content}</h2>;
		case 3:
			return <h3 class={className}>{content}</h3>;
		case 4:
			return <h4 class={className}>{content}</h4>;
		case 5:
			return <h5 class={className}>{content}</h5>;
		case 6:
			return <h6 class={className}>{content}</h6>;
		default:
			return <p class={className}>{content}</p>;
	}
}

export function renderAmendedSnippet(effect: AmendmentEffect): JSX.Element {
	const { plainText, spans } = effect.renderModel;
	const paragraphs = spans
		.filter((span) => span.type === "paragraph")
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const resolvedParagraphs =
		paragraphs.length > 0
			? paragraphs
			: ([
					{
						start: 0,
						end: plainText.length,
						type: "paragraph",
					},
				] as FormattingSpan[]);

	return (
		<>
			{resolvedParagraphs
				.filter((paragraph) => paragraph.end > paragraph.start)
				.map((paragraph) => renderParagraphBlock(paragraph, plainText, spans))}
		</>
	);
}
