import type {
	OperationMatchAttempt,
	ScopeRange,
} from "../../amendment-edit-engine-types";
import type { CanonicalPlanningOperation } from "../../amendment-edit-operation-adapter";

interface PushPatchArgs {
	start: number;
	end: number;
	deleted: string;
	inserted?: string;
	insertedPrefixPlain?: string;
	insertedSuffixPlain?: string;
	insertAt?: number;
}

interface RedesignateHandlerArgs {
	operation: CanonicalPlanningOperation;
	range: ScopeRange | null;
	scopedText: string;
	attempt: OperationMatchAttempt;
	pushPatch: (args: PushPatchArgs) => void;
}

export function handleRedesignateEdit(args: RedesignateHandlerArgs): void {
	const { operation, range, scopedText, attempt, pushPatch } = args;
	if (!range) return;
	if (operation.edit.kind !== "redesignate") return;

	const mapping = operation.edit.mappings[operation.redesignateMappingIndex];
	if (!mapping) return;
	const fromLabel =
		mapping.from.path[mapping.from.path.length - 1]?.label ?? "";
	const toLabel = mapping.to.path[mapping.to.path.length - 1]?.label ?? "";
	const marker = `(${fromLabel})`;
	const replacement = `(${toLabel})`;
	const localIndex = scopedText.indexOf(marker);
	attempt.searchText = marker;
	attempt.searchTextKind = "striking";
	attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
	if (localIndex < 0) return;

	pushPatch({
		start: range.start + localIndex,
		end: range.start + localIndex + marker.length,
		deleted: marker,
		inserted: replacement,
	});
}
