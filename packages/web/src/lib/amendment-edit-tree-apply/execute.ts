import {
	buildCanonicalDocument,
	type ParsedMarkdownDocument,
} from "../amendment-document-model";
import { applyPlannedPatchesTransaction } from "../amendment-edit-apply-transaction";
import type {
	CanonicalDocument,
	ClassificationOverride,
	FormattingSpan,
	OperationMatchAttempt,
	PlannedPatch,
	ResolutionIssue,
	ResolvedInstructionOperation,
} from "../amendment-edit-engine-types";
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
	resolutionModel: CanonicalDocument;
	renderPlainText: string;
	renderSpans: FormattingSpan[];
	resolvedOperationCount: number;
	patches: PlannedPatch[];
	attempts: OperationMatchAttempt[];
	issues: ResolutionIssue[];
	unsupportedReasons: string[];
}

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
	const sourceToPlainOffsets = new Array<number>(plainText.length + 1);
	for (let index = 0; index <= plainText.length; index += 1) {
		sourceToPlainOffsets[index] = index;
	}
	return {
		plainText,
		spans,
		sourceToPlainOffsets,
		rootRange: { start: 0, end: plainText.length, indent: 0 },
		nodesById: new Map(),
		rootNodeIds: [],
		paragraphs: [],
	};
}

function overlaps(left: PlannedPatch, right: PlannedPatch): boolean {
	return left.start < right.end && right.start < left.end;
}

function canonicalDocumentFromRenderModel(
	renderText: string,
	renderSpans: FormattingSpan[],
): CanonicalDocument {
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
		if (!isDeleted) {
			canonicalChars.push(renderText[index] ?? "");
		}
	}
	const canonicalText = canonicalChars.join("");
	const projectedSpans: FormattingSpan[] = [];
	for (const span of renderSpans) {
		if (span.type === "deletion") continue;
		const start =
			livePrefix[Math.max(0, Math.min(renderText.length, span.start))];
		const end = livePrefix[Math.max(0, Math.min(renderText.length, span.end))];
		if (end <= start) continue;
		projectedSpans.push({
			...span,
			start,
			end,
		});
	}
	const sourceToPlainOffsets = new Array<number>(canonicalText.length + 1);
	for (let index = 0; index <= canonicalText.length; index += 1) {
		sourceToPlainOffsets[index] = index;
	}
	const parsedMarkdownDocument: ParsedMarkdownDocument = {
		plainText: canonicalText,
		spans: projectedSpans,
		sourceToPlainOffsets,
	};
	return buildCanonicalDocument(canonicalText, parsedMarkdownDocument);
}

function recomputeResolutionModel(state: SequentialExecutionState): void {
	const canonicalDocument = canonicalDocumentFromRenderModel(
		state.renderPlainText,
		state.renderSpans,
	);
	state.resolutionModel = canonicalDocument;
}

function applyAcceptedPatchesToState(
	state: SequentialExecutionState,
	orderedPatches: PlannedPatch[],
): void {
	const offsetMap = buildCanonicalRenderOffsetMap(
		state.renderPlainText,
		state.renderSpans,
	);
	const renderPatches = orderedPatches.map((patch) => ({
		...patch,
		start: offsetMap.toRenderPoint(patch.start),
		end: offsetMap.toRenderPoint(patch.end),
		insertAt: offsetMap.toRenderPoint(patch.insertAt),
	}));
	const appliedRender = applyPlannedPatchesTransaction(
		toSpanOnlyModel(state.renderPlainText, state.renderSpans),
		renderPatches,
	);
	state.renderPlainText = appliedRender.plainText;
	state.renderSpans = appliedRender.spans;
	recomputeResolutionModel(state);
	state.patches.push(...orderedPatches);
}

function executeResolvedOperation(
	state: SequentialExecutionState,
	operation: ResolvedInstructionOperation,
	classificationOverrides?: ClassificationOverride[],
): PlannedPatch[] {
	const { patches, attempt } = planOperationEdit(
		state.resolutionModel,
		operation,
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
			state.resolutionModel,
			operation,
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
			state.resolutionModel,
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
