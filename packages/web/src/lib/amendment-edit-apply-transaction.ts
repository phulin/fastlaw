import type {
	ApplyPlannedPatchesResult,
	DocumentModel,
	FormattingSpan,
	PlannedPatch,
} from "./amendment-edit-engine-types";

function shiftInsertedSpans(
	spans: FormattingSpan[],
	offset: number,
): FormattingSpan[] {
	return spans.map((span) => ({
		...span,
		start: span.start + offset,
		end: span.end + offset,
	}));
}

function shiftSpansForInsertion(
	spans: FormattingSpan[],
	insertAt: number,
	insertedLength: number,
): FormattingSpan[] {
	if (insertedLength <= 0) return spans.map((span) => ({ ...span }));
	return spans.map((span) => {
		if (span.end <= insertAt) return { ...span };
		if (span.start >= insertAt) {
			return {
				...span,
				start: span.start + insertedLength,
				end: span.end + insertedLength,
			};
		}
		return { ...span, end: span.end + insertedLength };
	});
}

function splitContainerSpansAroundInsertion(
	spans: FormattingSpan[],
	insertAt: number,
	insertedLength: number,
): FormattingSpan[] {
	if (insertedLength <= 0) return spans.map((span) => ({ ...span }));
	const result: FormattingSpan[] = [];
	for (const span of spans) {
		if (span.start >= span.end) continue;
		if (span.end <= insertAt) {
			result.push({ ...span });
			continue;
		}
		if (span.start >= insertAt) {
			result.push({
				...span,
				start: span.start + insertedLength,
				end: span.end + insertedLength,
			});
			continue;
		}
		if (span.type === "paragraph" || span.type === "heading") {
			const left = { ...span, end: insertAt };
			const right = {
				...span,
				start: insertAt + insertedLength,
				end: span.end + insertedLength,
			};
			if (left.end > left.start) result.push(left);
			if (right.end > right.start) result.push(right);
			continue;
		}
		result.push({ ...span, end: span.end + insertedLength });
	}
	return result;
}

function normalizeParagraphSpanContainment(
	spans: FormattingSpan[],
): FormattingSpan[] {
	const paragraphs = spans
		.filter((span) => span.type === "paragraph" && span.end > span.start)
		.map((span) => ({ ...span }));
	const nonParagraphs = spans
		.filter((span) => span.type !== "paragraph" && span.end > span.start)
		.map((span) => ({ ...span }));

	const sorted = paragraphs.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	const normalized: FormattingSpan[] = [];

	for (const paragraph of sorted) {
		const next = { ...paragraph };
		const previous = normalized[normalized.length - 1];
		if (!previous) {
			normalized.push(next);
			continue;
		}
		if (next.start >= previous.end) {
			normalized.push(next);
			continue;
		}

		previous.end = Math.max(previous.end, next.end);
	}

	return [...nonParagraphs, ...normalized];
}

function materializeEditsFromPatches(
	model: DocumentModel,
	patches: PlannedPatch[],
): { plainText: string; spans: FormattingSpan[] } {
	const orderedPatches = patches
		.map((patch, patchId) => ({ patch, patchId }))
		.sort((left, right) => {
			if (left.patch.start !== right.patch.start) {
				return right.patch.start - left.patch.start;
			}
			return right.patchId - left.patchId;
		});

	let workingText = model.plainText;
	let workingSpans = model.spans.map((span) => ({ ...span }));

	for (const { patch } of orderedPatches) {
		const deleteStart = patch.start;
		const deleteEnd = patch.end;
		const deletedLength = deleteEnd - deleteStart;
		const insertedPlain = patch.insertedPlain;
		const insertedSpans = patch.insertedSpans;
		const insertedPrefixPlain = patch.insertedPrefixPlain ?? "";
		const insertedSuffixPlain = patch.insertedSuffixPlain ?? "";
		const insertedTotalLength =
			insertedPrefixPlain.length +
			insertedPlain.length +
			insertedSuffixPlain.length;

		if (deletedLength > 0) {
			workingSpans.push({
				type: "deletion",
				start: deleteStart,
				end: deleteEnd,
			});
		}

		const insertAt = patch.insertAt;

		if (insertedTotalLength > 0) {
			workingText = `${workingText.slice(0, insertAt)}${insertedPrefixPlain}${insertedPlain}${insertedSuffixPlain}${workingText.slice(insertAt)}`;
			const insertedHasParagraphs = insertedSpans.some(
				(span) => span.type === "paragraph",
			);
			workingSpans = insertedHasParagraphs
				? splitContainerSpansAroundInsertion(
						workingSpans,
						insertAt,
						insertedTotalLength,
					)
				: shiftSpansForInsertion(workingSpans, insertAt, insertedTotalLength);
			workingSpans.push(
				...shiftInsertedSpans(
					insertedSpans,
					insertAt + insertedPrefixPlain.length,
				),
			);
			workingSpans.push({
				type: "insertion",
				start: insertAt,
				end: insertAt + insertedTotalLength,
			});
		}
	}

	return {
		plainText: workingText,
		spans: normalizeParagraphSpanContainment(
			workingSpans.filter((span) => span.end > span.start),
		),
	};
}

export function applyPlannedPatchesTransaction(
	model: DocumentModel,
	patches: PlannedPatch[],
): ApplyPlannedPatchesResult {
	const materialized = materializeEditsFromPatches(model, patches);
	return {
		plainText: materialized.plainText,
		spans: materialized.spans,
	};
}
