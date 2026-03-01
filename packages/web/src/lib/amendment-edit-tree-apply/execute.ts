import { applyPatchesToCanonicalDocument } from "../amendment-edit-canonical-update";
import type {
	CanonicalDocument,
	ClassificationOverride,
	OperationMatchAttempt,
	PlannedPatch,
	ResolutionIssue,
	ResolvedInstructionOperation,
} from "../amendment-edit-engine-types";
import { toCanonicalPlanningOperation } from "../amendment-edit-operation-adapter";
import {
	applyAttemptOutcome,
	countPatchesByOperation,
	selectNonOverlappingPatches,
} from "../amendment-edit-patch-utils";
import { planOperationEdit } from "../amendment-edit-planner";
import {
	type InstructionSemanticTree,
	LocationRestrictionKind,
	SemanticNodeType,
	UltimateEditKind,
} from "../amendment-edit-tree";
import {
	appendScopeContextText,
	mergeTargets,
	normalizePath,
	pathToText,
	refToHierarchyPath,
	resolveEdit,
	type TraversalContext,
	toHierarchyType,
} from "./resolve";

export interface SequentialExecutionState {
	document: CanonicalDocument;
	resolvedOperationCount: number;
	patchBatches: PlannedPatch[][];
	attempts: OperationMatchAttempt[];
	issues: ResolutionIssue[];
	unsupportedReasons: string[];
}

function overlaps(left: PlannedPatch, right: PlannedPatch): boolean {
	return left.start < right.end && right.start < left.end;
}

function applyAcceptedPatchesToState(
	state: SequentialExecutionState,
	orderedPatches: PlannedPatch[],
): void {
	state.document = applyPatchesToCanonicalDocument(
		state.document,
		orderedPatches,
	);
	state.patchBatches.push(orderedPatches);
}

function executeResolvedOperation(
	state: SequentialExecutionState,
	operation: ResolvedInstructionOperation,
	classificationOverrides?: ClassificationOverride[],
): PlannedPatch[] {
	const { patches, attempt } = planOperationEdit(
		state.document,
		toCanonicalPlanningOperation(operation),
		classificationOverrides,
	);
	if (attempt.outcome !== "scope_unresolved") {
		attempt.patchApplied = patches.length > 0;
		attempt.outcome = patches.length > 0 ? "applied" : "no_patch";
	}
	state.attempts.push(attempt);

	if (patches.length === 0) {
		return [];
	}

	const orderedPatches = [...patches].sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	applyAcceptedPatchesToState(state, orderedPatches);
	return orderedPatches;
}

function executeResolvedOperationsSnapshot(
	state: SequentialExecutionState,
	operations: ResolvedInstructionOperation[],
	classificationOverrides?: ClassificationOverride[],
): Set<number> {
	const tentativePatches: PlannedPatch[] = [];
	const attempts: { operationIndex: number; attempt: OperationMatchAttempt }[] =
		[];
	for (const operation of operations) {
		const planned = planOperationEdit(
			state.document,
			toCanonicalPlanningOperation(operation),
			classificationOverrides,
		);
		tentativePatches.push(...planned.patches);
		attempts.push({
			operationIndex: operation.operationIndex,
			attempt: planned.attempt,
		});
	}

	const accepted = selectNonOverlappingPatches(
		tentativePatches.sort(
			(left, right) =>
				left.operationIndex - right.operationIndex || left.start - right.start,
		),
		overlaps,
	);
	const appliedCountByOperation = countPatchesByOperation(accepted);
	for (const entry of attempts) {
		applyAttemptOutcome(
			entry.attempt,
			appliedCountByOperation.get(entry.operationIndex) ?? 0,
		);
		state.attempts.push(entry.attempt);
	}

	if (accepted.length === 0) {
		return new Set<number>();
	}

	const orderedPatches = [...accepted].sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	applyAcceptedPatchesToState(state, orderedPatches);
	return new Set<number>(appliedCountByOperation.keys());
}

function registerAppliedRedesignation(
	context: TraversalContext,
	operation: ResolvedInstructionOperation,
): void {
	if (operation.edit.kind !== UltimateEditKind.Redesignate) return;
	const mapping = operation.edit.mappings[operation.redesignateMappingIndex];
	if (!mapping) return;
	const toHierarchy = refToHierarchyPath(mapping.to);
	const fullToPath = pathToText(
		normalizePath(mergeTargets(context.target, toHierarchy)),
	);
	const fromLabel = mapping.from.path[mapping.from.path.length - 1]?.label;
	if (!fullToPath || !fromLabel) return;
	context.redesignations.set(fullToPath, fromLabel);
}

export function executeTreeSequential(
	nodes: InstructionSemanticTree["children"],
	context: TraversalContext,
	counter: { index: number },
	state: SequentialExecutionState,
): void {
	for (const node of nodes) {
		if (node.type === SemanticNodeType.Scope) {
			const scopeTarget = mergeTargets(context.target, [
				{ type: toHierarchyType(node.scope.kind), val: node.scope.label },
			]);
			const scopeContextTexts = appendScopeContextText(
				context.scopeContextTexts,
				node.sourceText,
			);
			executeTreeSequential(
				node.children,
				{ ...context, target: scopeTarget, scopeContextTexts },
				counter,
				state,
			);
			continue;
		}

		if (node.type === SemanticNodeType.LocationRestriction) {
			const scopeContextTexts = appendScopeContextText(
				context.scopeContextTexts,
				node.sourceText,
			);
			if (node.restriction.kind === LocationRestrictionKind.In) {
				if (node.restriction.refs.length === 0) {
					state.unsupportedReasons.push("in_location_empty_refs");
					continue;
				}
				for (const ref of node.restriction.refs) {
					const target = mergeTargets(context.target, refToHierarchyPath(ref));
					executeTreeSequential(
						node.children,
						{ ...context, target, scopeContextTexts },
						counter,
						state,
					);
				}
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterPreceding) {
				const matterPrecedingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				executeTreeSequential(
					node.children,
					{
						...context,
						scopeContextTexts,
						matterPreceding: node.restriction.ref,
						matterPrecedingTarget,
					},
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.AtEnd) {
				const target = mergeTargets(
					context.target,
					node.restriction.ref
						? refToHierarchyPath(node.restriction.ref)
						: null,
				);
				executeTreeSequential(
					node.children,
					{
						...context,
						scopeContextTexts,
						target,
						unanchoredInsertMode: "add_at_end",
						atEndOnly: true,
					},
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceOrdinal) {
				executeTreeSequential(
					node.children,
					{
						...context,
						scopeContextTexts,
						sentenceOrdinal: node.restriction.ordinal,
					},
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceLast) {
				executeTreeSequential(
					node.children,
					{ ...context, scopeContextTexts, sentenceOrdinal: -1 },
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterFollowing) {
				const matterFollowingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				executeTreeSequential(
					node.children,
					{ ...context, scopeContextTexts, matterFollowingTarget },
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.Before) {
				executeTreeSequential(
					node.children,
					{
						...context,
						scopeContextTexts,
						beforeInnerTarget: node.restriction.target,
					},
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.After) {
				executeTreeSequential(
					node.children,
					{
						...context,
						scopeContextTexts,
						afterInnerTarget: node.restriction.target,
					},
					counter,
					state,
				);
				continue;
			}

			state.unsupportedReasons.push(
				`location_${node.restriction.kind}_not_supported`,
			);
			continue;
		}

		if (node.type !== SemanticNodeType.Edit) continue;
		const nested = resolveEdit(
			state.document,
			node,
			context,
			counter,
			state.issues,
		);
		state.unsupportedReasons.push(...nested.unsupportedReasons);
		state.resolvedOperationCount += nested.resolved.length;
		if (
			node.edit.kind === UltimateEditKind.Redesignate &&
			nested.resolved.length > 1
		) {
			const appliedOperations = executeResolvedOperationsSnapshot(
				state,
				nested.resolved,
				context.classificationOverrides,
			);
			for (const operation of nested.resolved) {
				if (!appliedOperations.has(operation.operationIndex)) continue;
				registerAppliedRedesignation(context, operation);
			}
			continue;
		}
		for (const operation of nested.resolved) {
			const appliedPatches = executeResolvedOperation(
				state,
				operation,
				context.classificationOverrides,
			);
			if (appliedPatches.length > 0) {
				registerAppliedRedesignation(context, operation);
			}
		}
	}
}
