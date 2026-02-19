import type {
	ApplyPlannedPatchesResult,
	PlannedPatch,
} from "./amendment-edit-engine-types";

function applyPatch(
	text: string,
	patch: Pick<PlannedPatch, "start" | "end" | "inserted">,
): string {
	return `${text.slice(0, patch.start)}${patch.inserted}${text.slice(patch.end)}`;
}

function deltaForPatch(patch: PlannedPatch): number {
	return patch.inserted.length - patch.deleted.length;
}

function toReplacementRanges(patches: PlannedPatch[]) {
	const sortedByOperation = [...patches].sort(
		(left, right) => left.operationIndex - right.operationIndex,
	);
	return sortedByOperation
		.map((patch, index) => {
			let deltaBefore = 0;
			for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
				const prior = sortedByOperation[priorIndex];
				if (!prior) continue;
				if (prior.end <= patch.start) {
					deltaBefore += deltaForPatch(prior);
				}
			}
			const finalStart = patch.start + deltaBefore;
			return {
				start: finalStart,
				end: finalStart + patch.inserted.length,
				deletedText: patch.deleted,
			};
		})
		.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function applyPlannedPatchesTransaction(
	sourceText: string,
	patches: PlannedPatch[],
): ApplyPlannedPatchesResult {
	const applyOrder = [...patches].sort((left, right) => {
		if (left.start !== right.start) return right.start - left.start;
		return right.operationIndex - left.operationIndex;
	});

	let workingText = sourceText;
	for (const patch of applyOrder) {
		workingText = applyPatch(workingText, patch);
	}

	return {
		text: workingText,
		replacements: toReplacementRanges(patches),
	};
}
