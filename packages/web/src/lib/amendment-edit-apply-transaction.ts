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
		if (span.start > insertAt) {
			return {
				...span,
				start: span.start + insertedLength,
				end: span.end + insertedLength,
			};
		}
		return { ...span, end: span.end + insertedLength };
	});
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
			workingSpans = shiftSpansForInsertion(
				workingSpans,
				insertAt,
				insertedTotalLength,
			);
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
		spans: workingSpans.filter((span) => span.end > span.start),
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
