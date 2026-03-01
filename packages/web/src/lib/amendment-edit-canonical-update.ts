import {
	buildCanonicalParagraphsFromTextAndSpans,
	rebuildCanonicalDocumentFromParagraphs,
} from "./amendment-document-model";
import { applyPlannedPatchesTransaction } from "./amendment-edit-apply-transaction";
import type {
	CanonicalDocument,
	DocumentParagraph,
	FormattingSpan,
	PlannedPatch,
} from "./amendment-edit-engine-types";
import { extractLeadingLabels } from "./markdown-hierarchy-parser";

interface CanonicalRenderOffsetMap {
	toRenderPoint(canonicalOffset: number): number;
}

function buildCanonicalRenderOffsetMap(
	renderText: string,
	spans: FormattingSpan[],
): CanonicalRenderOffsetMap {
	const deletedMask = new Uint8Array(renderText.length);
	for (const span of spans) {
		if (span.type !== "deletion") continue;
		const start = Math.max(0, Math.min(renderText.length, span.start));
		const end = Math.max(0, Math.min(renderText.length, span.end));
		for (let index = start; index < end; index += 1) {
			deletedMask[index] = 1;
		}
	}

	const toRenderPoint = (canonicalOffset: number): number => {
		let liveCount = 0;
		const target = Math.max(0, canonicalOffset);
		for (let index = 0; index < renderText.length; index += 1) {
			if (liveCount === target) return index;
			if (deletedMask[index] === 1) continue;
			liveCount += 1;
		}
		return renderText.length;
	};

	return { toRenderPoint };
}

function toSpanOnlyModel(
	plainText: string,
	spans: FormattingSpan[],
): CanonicalDocument {
	return {
		plainText,
		spans,
		rootRange: { start: 0, end: plainText.length, indent: 0 },
		nodesById: new Map(),
		rootNodeIds: [],
		paragraphs: [],
	};
}

function projectRenderModelToCanonical(
	renderText: string,
	renderSpans: FormattingSpan[],
): { plainText: string; spans: FormattingSpan[] } {
	const deletedMask = new Uint8Array(renderText.length);
	for (const span of renderSpans) {
		if (span.type !== "deletion") continue;
		const start = Math.max(0, Math.min(renderText.length, span.start));
		const end = Math.max(0, Math.min(renderText.length, span.end));
		for (let index = start; index < end; index += 1) {
			deletedMask[index] = 1;
		}
	}

	const livePrefix = new Array<number>(renderText.length + 1).fill(0);
	const canonicalChars: string[] = [];
	for (let index = 0; index < renderText.length; index += 1) {
		const isDeleted = deletedMask[index] === 1;
		livePrefix[index + 1] = livePrefix[index] + (isDeleted ? 0 : 1);
		if (!isDeleted) canonicalChars.push(renderText[index] ?? "");
	}

	const canonicalText = canonicalChars.join("");
	const projectedSpans: FormattingSpan[] = [];
	for (const span of renderSpans) {
		if (span.type === "deletion") continue;
		const start =
			livePrefix[Math.max(0, Math.min(renderText.length, span.start))];
		const end = livePrefix[Math.max(0, Math.min(renderText.length, span.end))];
		if (end <= start) continue;
		projectedSpans.push({ ...span, start, end });
	}

	return { plainText: canonicalText, spans: projectedSpans };
}

function canUseParagraphFastPath(
	document: CanonicalDocument,
	projectedSpans: FormattingSpan[],
): boolean {
	const paragraphSpans = projectedSpans.filter(
		(span) => span.type === "paragraph",
	);
	if (paragraphSpans.length !== document.paragraphs.length) return false;

	for (let index = 0; index < paragraphSpans.length; index += 1) {
		const span = paragraphSpans[index];
		const previous = document.paragraphs[index];
		if (!span || !previous) return false;
		if (span.start > span.end) return false;
	}

	return true;
}

function updateParagraphsFast(
	document: CanonicalDocument,
	projectedPlainText: string,
	projectedSpans: FormattingSpan[],
): DocumentParagraph[] | null {
	const paragraphSpans = projectedSpans
		.filter((span) => span.type === "paragraph")
		.sort((left, right) => left.start - right.start || left.end - right.end);
	if (paragraphSpans.length !== document.paragraphs.length) return null;

	return paragraphSpans.map((span, index) => {
		const previous = document.paragraphs[index];
		if (!previous) {
			return {
				index,
				start: span.start,
				end: span.end,
				indent: (span.metadata?.quoteDepth as number) ?? 0,
				leadingLabels: [],
				text: projectedPlainText.slice(span.start, span.end),
			};
		}

		const text = projectedPlainText.slice(span.start, span.end);
		const firstLine = text.split("\n")[0] ?? "";
		return {
			index,
			start: span.start,
			end: span.end,
			indent: (span.metadata?.quoteDepth as number) ?? previous.indent,
			leadingLabels: extractLeadingLabels(firstLine),
			text,
		};
	});
}

export function applyPatchesToCanonicalDocument(
	document: CanonicalDocument,
	orderedPatches: PlannedPatch[],
): CanonicalDocument {
	const applied = applyPlannedPatchesTransaction(
		toSpanOnlyModel(document.plainText, document.spans),
		orderedPatches,
	);
	const projected = projectRenderModelToCanonical(
		applied.plainText,
		applied.spans,
	);
	const paragraphs = canUseParagraphFastPath(document, projected.spans)
		? (updateParagraphsFast(document, projected.plainText, projected.spans) ??
			buildCanonicalParagraphsFromTextAndSpans(
				projected.plainText,
				projected.spans,
			))
		: buildCanonicalParagraphsFromTextAndSpans(
				projected.plainText,
				projected.spans,
			);
	return rebuildCanonicalDocumentFromParagraphs({
		plainText: projected.plainText,
		spans: projected.spans,
		paragraphs,
	});
}

export function materializeRenderModelFromPatchBatches(
	initialDocument: CanonicalDocument,
	patchBatches: PlannedPatch[][],
): { plainText: string; spans: FormattingSpan[] } {
	let renderPlainText = initialDocument.plainText;
	let renderSpans = initialDocument.spans;

	for (const batch of patchBatches) {
		if (batch.length === 0) continue;
		const offsetMap = buildCanonicalRenderOffsetMap(
			renderPlainText,
			renderSpans,
		);
		const renderPatches = batch.map((patch) => ({
			...patch,
			start: offsetMap.toRenderPoint(patch.start),
			end: offsetMap.toRenderPoint(patch.end),
			insertAt: offsetMap.toRenderPoint(patch.insertAt),
		}));
		const appliedRender = applyPlannedPatchesTransaction(
			toSpanOnlyModel(renderPlainText, renderSpans),
			renderPatches,
		);
		renderPlainText = appliedRender.plainText;
		renderSpans = appliedRender.spans;
	}

	return { plainText: renderPlainText, spans: renderSpans };
}
