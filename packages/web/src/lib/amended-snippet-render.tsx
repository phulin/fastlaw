import type { JSX } from "solid-js";
import type { FormattingSpan } from "./amendment-edit-engine-types";
import type { AmendmentEffect } from "./amendment-edit-tree-apply";

const PARAGRAPH_CONTEXT_WINDOW = 3;

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

function getQuoteDepthForParagraph(paragraph: FormattingSpan): number {
	const explicitDepth = paragraph.metadata?.quoteDepth;
	if (typeof explicitDepth === "number" && Number.isFinite(explicitDepth)) {
		return explicitDepth;
	}
	return 0;
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
			span.start < paragraph.end &&
			span.end > paragraph.start &&
			span.end > span.start,
	);
	const clippedParagraphSpans = paragraphSpans
		.map((span) => ({
			...span,
			start: Math.max(span.start, paragraph.start),
			end: Math.min(span.end, paragraph.end),
		}))
		.filter((span) => span.end > span.start);
	const boundaries = new Set<number>([0, paragraphText.length]);
	for (const span of clippedParagraphSpans) {
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
		const activeSpans = clippedParagraphSpans
			.filter((span) => span.start <= globalStart && span.end >= globalEnd)
			.sort(
				(left, right) =>
					inlinePriority(left.type) - inlinePriority(right.type) ||
					left.start - right.start ||
					right.end - left.end,
			);
		const wrapped = activeSpans.reduceRight<JSX.Element>(
			(content, span) => wrapInline(span, content),
			segmentText,
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
		Math.min(5, getQuoteDepthForParagraph(paragraph)),
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

	const modifiedParagraphIndices = new Set<number>();
	resolvedParagraphs.forEach((p, i) => {
		const isModified = spans.some(
			(span) =>
				(span.type === "insertion" ||
					span.type === "delete" ||
					span.type === "deletion") &&
				span.start < p.end &&
				span.end > p.start,
		);
		if (isModified) {
			modifiedParagraphIndices.add(i);
		}
	});

	const visibleIndices = new Set<number>();
	if (modifiedParagraphIndices.size > 0) {
		for (const index of modifiedParagraphIndices) {
			const start = Math.max(0, index - PARAGRAPH_CONTEXT_WINDOW);
			const end = Math.min(
				resolvedParagraphs.length - 1,
				index + PARAGRAPH_CONTEXT_WINDOW,
			);
			for (let visibleIndex = start; visibleIndex <= end; visibleIndex += 1) {
				visibleIndices.add(visibleIndex);
			}
		}
	} else {
		for (let i = 0; i < Math.min(3, resolvedParagraphs.length); i++) {
			visibleIndices.add(i);
		}
	}

	const sortedVisibleIndices = Array.from(visibleIndices).sort((a, b) => a - b);

	const renderBlocks: JSX.Element[] = [];
	let lastIndex = -1;

	for (const index of sortedVisibleIndices) {
		if (lastIndex !== -1 && index > lastIndex + 1) {
			renderBlocks.push(
				<div class="pdf-amended-snippet-ellipsis">
					<p>...</p>
				</div>,
			);
		}
		const p = resolvedParagraphs[index];
		if (p && p.end > p.start) {
			renderBlocks.push(renderParagraphBlock(p, plainText, spans));
		}
		lastIndex = index;
	}

	if (
		sortedVisibleIndices.length > 0 &&
		(sortedVisibleIndices[sortedVisibleIndices.length - 1] ?? 0) <
			resolvedParagraphs.length - 1
	) {
		renderBlocks.push(
			<div class="pdf-amended-snippet-ellipsis">
				<p>...</p>
			</div>,
		);
	}

	return <>{renderBlocks}</>;
}
