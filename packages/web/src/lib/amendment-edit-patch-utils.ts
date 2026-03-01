import type {
	OperationMatchAttempt,
	PlannedPatch,
} from "./amendment-edit-engine-types";

export function selectNonOverlappingPatches(
	patches: PlannedPatch[],
	overlaps: (left: PlannedPatch, right: PlannedPatch) => boolean,
): PlannedPatch[] {
	const accepted: PlannedPatch[] = [];
	for (const patch of patches) {
		const hasConflict = accepted.some((existing) => overlaps(existing, patch));
		if (hasConflict) continue;
		accepted.push(patch);
	}
	return accepted;
}

export function countPatchesByOperation(
	patches: PlannedPatch[],
): Map<number, number> {
	const appliedCountByOperation = new Map<number, number>();
	for (const patch of patches) {
		appliedCountByOperation.set(
			patch.operationIndex,
			(appliedCountByOperation.get(patch.operationIndex) ?? 0) + 1,
		);
	}
	return appliedCountByOperation;
}

export function applyAttemptOutcome(
	attempt: OperationMatchAttempt,
	appliedCount: number,
): void {
	if (attempt.outcome === "scope_unresolved") return;
	attempt.patchApplied = appliedCount > 0;
	attempt.outcome = appliedCount > 0 ? "applied" : "no_patch";
}
