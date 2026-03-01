import type { ResolvedInstructionOperation } from "./amendment-edit-engine-types";

export type CanonicalPlanningOperation = Pick<
	ResolvedInstructionOperation,
	| "operationIndex"
	| "nodeText"
	| "originalNodeText"
	| "scopeContextTexts"
	| "edit"
	| "addAtEnd"
	| "redesignateMappingIndex"
	| "sentenceOrdinal"
	| "atEndOnly"
	| "hasMatterPrecedingTarget"
	| "hasMatterFollowingTarget"
	| "matterPrecedingRefKind"
	| "matterPrecedingRefLabel"
	| "matterFollowingRefKind"
	| "matterFollowingRefLabel"
	| "hasExplicitTargetPath"
	| "targetPathText"
	| "resolvedTargetId"
	| "resolvedMatterPrecedingTargetId"
	| "resolvedMatterFollowingTargetId"
	| "resolvedThroughTargetId"
	| "beforeInnerTarget"
	| "afterInnerTarget"
	| "structuralStrikeMode"
	| "resolvedStructuralTargetIds"
	| "resolvedAnchorTargetId"
	| "resolvedMoveFromIds"
	| "resolvedMoveAnchorId"
>;

export function toCanonicalPlanningOperation(
	operation: ResolvedInstructionOperation,
): CanonicalPlanningOperation {
	return operation;
}
