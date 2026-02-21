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
		if (span.end < insertAt) return { ...span };
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

function shiftSpansForDeletion(
	spans: FormattingSpan[],
	deleteStart: number,
	deleteEnd: number,
): FormattingSpan[] {
	const deletedLength = deleteEnd - deleteStart;
	if (deletedLength <= 0) return spans.map((span) => ({ ...span }));
	const nextSpans: FormattingSpan[] = [];
	for (const span of spans) {
		if (span.end <= deleteStart) {
			nextSpans.push({ ...span });
			continue;
		}
		if (span.start >= deleteEnd) {
			nextSpans.push({
				...span,
				start: span.start - deletedLength,
				end: span.end - deletedLength,
			});
			continue;
		}
		const startInDeletion = span.start >= deleteStart && span.start < deleteEnd;
		const endInDeletion = span.end > deleteStart && span.end <= deleteEnd;
		if (startInDeletion && endInDeletion) {
			continue;
		}
		if (span.start < deleteStart && span.end > deleteEnd) {
			nextSpans.push({
				...span,
				start: span.start,
				end: span.end - deletedLength,
			});
			continue;
		}
		if (span.start < deleteStart && endInDeletion) {
			nextSpans.push({
				...span,
				start: span.start,
				end: deleteStart,
			});
			continue;
		}
		if (startInDeletion && span.end > deleteEnd) {
			nextSpans.push({
				...span,
				start: deleteStart,
				end: span.end - deletedLength,
			});
		}
	}
	return nextSpans.filter((span) => span.end > span.start);
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
		const deletedPlain = patch.deletedPlain;
		const insertedPlain = patch.insertedPlain;
		const insertedSpans = patch.insertedSpans;
		let insertedPrefixPlain = patch.insertedPrefixPlain ?? "";
		let insertedSuffixPlain = patch.insertedSuffixPlain ?? "";
		if (deletedLength > 0 && insertedPlain.length > 0) {
			const leadingWhitespace = deletedPlain.match(/^\s+/)?.[0] ?? "";
			const trailingWhitespace = deletedPlain.match(/\s+$/)?.[0] ?? "";
			const insertedCore = `${insertedPrefixPlain}${insertedPlain}${insertedSuffixPlain}`;
			if (!insertedCore.startsWith(" ") && !insertedCore.startsWith("\n")) {
				insertedPrefixPlain = `${leadingWhitespace}${insertedPrefixPlain}`;
			}
			if (!insertedCore.endsWith(" ") && !insertedCore.endsWith("\n")) {
				insertedSuffixPlain = `${insertedSuffixPlain}${trailingWhitespace}`;
			}
		}
		const insertedTotalLength =
			insertedPrefixPlain.length +
			insertedPlain.length +
			insertedSuffixPlain.length;

		if (deletedLength > 0) {
			workingText = `${workingText.slice(0, deleteStart)}${workingText.slice(deleteEnd)}`;
			workingSpans = shiftSpansForDeletion(
				workingSpans,
				deleteStart,
				deleteEnd,
			);
		}

		let insertAt = patch.insertAt;
		if (deletedLength > 0) {
			if (insertAt <= deleteStart) {
				// no-op
			} else if (insertAt >= deleteEnd) {
				insertAt -= deletedLength;
			} else {
				insertAt = deleteStart;
			}
		}

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
