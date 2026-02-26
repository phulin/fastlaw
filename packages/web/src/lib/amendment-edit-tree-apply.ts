import {
	buildAmendmentDocumentModel,
	type PlainDocument,
} from "./amendment-document-model";
import {
	applyPlannedPatchesToWorkingText,
	applyPlannedPatchesTransaction,
} from "./amendment-edit-apply-transaction";
import type {
	ClassificationOverride,
	DocumentModel,
	FormattingSpan,
	HierarchyLevel,
	OperationMatchAttempt,
	PlannedPatch,
	ResolutionIssue,
	ResolvedInstructionOperation,
	StructuralNode,
} from "./amendment-edit-engine-types";
import { planOperationEdit } from "./amendment-edit-planner";
import {
	type EditNode,
	type EditTarget,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	ScopeKind,
	SemanticNodeType,
	type StructuralReference,
	textFromEditTarget,
	textSearchFromEditTarget,
	UltimateEditKind,
} from "./amendment-edit-tree";
import { renderMarkdown } from "./markdown";

interface ApplyEditTreeArgs {
	tree: InstructionSemanticTree;
	sectionPath: string;
	sectionBody: string;
	parsedDocument?: PlainDocument;
	instructionText?: string;
	classificationOverrides?: ClassificationOverride[];
}

type AmendmentSegmentKind = "unchanged" | "deleted" | "inserted";

interface AmendmentEffectSegment {
	kind: AmendmentSegmentKind;
	text: string;
}

interface AmendmentEffectDebug {
	sectionTextLength: number;
	operationCount: number;
	operationAttempts: OperationMatchAttempt[];
	failureReason: string | null;
	pipeline: {
		resolvedOperationCount: number;
		plannedPatchCount: number;
		resolutionIssueCount: number;
		resolutionIssues: ResolutionIssue[];
	};
}

export type ApplyFailureReasonKind =
	| "target_unresolved"
	| "target_ambiguous"
	| "scope_unresolved"
	| "no_match";

export interface FailedApplyItem {
	operationIndex: number;
	operationType: string;
	text: string;
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">;
	targetPath: string | null;
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
	wasTranslated: boolean;
	translatedInstructionText: string | null;
}

export interface AmendmentApplySummary {
	partiallyApplied: boolean;
	failedItems: FailedApplyItem[];
	wasTranslated: boolean;
}

export interface AmendmentEffect {
	status: "ok" | "unsupported";
	sectionPath: string;
	renderModel: {
		plainText: string;
		spans: FormattingSpan[];
	};
	segments: AmendmentEffectSegment[];
	changes: Array<{ deleted: string; inserted: string }>;
	deleted: string[];
	inserted: string[];
	annotatedHtml?: string;
	applySummary: AmendmentApplySummary;
	debug: AmendmentEffectDebug;
}

// --- Resolver helpers ---

function pathToText(path: HierarchyLevel[] | undefined): string {
	if (!path || path.length === 0) return "";
	return path.map((segment) => `${segment.type}:${segment.val}`).join(" > ");
}

function normalizePath(path: HierarchyLevel[] | undefined): HierarchyLevel[] {
	if (!path) return [];
	return path.filter((segment) => segment.type !== "section");
}

function matchesSegment(
	node: StructuralNode,
	segment: HierarchyLevel,
): boolean {
	return (
		node.kind === segment.type &&
		node.label.toLowerCase() === segment.val.toLowerCase()
	);
}

function labelMatchesSegment(
	node: StructuralNode,
	segment: HierarchyLevel,
): boolean {
	return node.label.toLowerCase() === segment.val.toLowerCase();
}

function filterCandidateIds(
	model: DocumentModel,
	candidateIds: string[],
	segment: HierarchyLevel,
): string[] {
	const exactMatches = candidateIds.filter((candidateId) => {
		const node = model.nodesById.get(candidateId);
		if (!node) return false;
		return matchesSegment(node, segment);
	});
	if (exactMatches.length > 0) return exactMatches;
	return candidateIds.filter((candidateId) => {
		const node = model.nodesById.get(candidateId);
		if (!node) return false;
		return labelMatchesSegment(node, segment);
	});
}

function collectDescendantIds(model: DocumentModel, nodeId: string): string[] {
	const descendants: string[] = [];
	const stack = [...(model.nodesById.get(nodeId)?.childIds ?? [])];
	while (stack.length > 0) {
		const currentId = stack.pop();
		if (!currentId) continue;
		descendants.push(currentId);
		const currentNode = model.nodesById.get(currentId);
		if (!currentNode) continue;
		for (const childId of currentNode.childIds) {
			stack.push(childId);
		}
	}
	return descendants;
}

function resolvePathCandidates(
	model: DocumentModel,
	path: HierarchyLevel[] | undefined,
): string[] {
	if (!path || path.length === 0) return [];

	const currentPath = [...path];
	let currentCandidates: string[] = [];

	// Skip leading code_reference and section segments if they don't match root nodes.
	// This allows resolution to start from the actual document content (e.g. subsections).
	while (currentPath.length > 0) {
		const segment = currentPath[0];
		currentCandidates = filterCandidateIds(model, model.rootNodeIds, segment);
		if (currentCandidates.length > 0) {
			break;
		}
		if (segment.type === "code_reference" || segment.type === "section") {
			currentPath.shift();
			continue;
		}
		break;
	}

	if (currentCandidates.length === 0) {
		return [];
	}

	const restSegments = currentPath.slice(1);
	for (const segment of restSegments) {
		const childCandidateIds: string[] = [];
		for (const candidateId of currentCandidates) {
			const candidateNode = model.nodesById.get(candidateId);
			if (!candidateNode) continue;
			for (const childId of candidateNode.childIds) {
				childCandidateIds.push(childId);
			}
		}
		const nextCandidates = filterCandidateIds(
			model,
			childCandidateIds,
			segment,
		);
		if (nextCandidates.length > 0) {
			currentCandidates = nextCandidates;
			continue;
		}

		const descendantCandidateIds: string[] = [];
		const seenIds = new Set<string>();
		for (const candidateId of currentCandidates) {
			const descendants = collectDescendantIds(model, candidateId);
			for (const descendantId of descendants) {
				if (seenIds.has(descendantId)) continue;
				seenIds.add(descendantId);
				descendantCandidateIds.push(descendantId);
			}
		}
		currentCandidates = filterCandidateIds(
			model,
			descendantCandidateIds,
			segment,
		);
		if (currentCandidates.length === 0) {
			return [];
		}
	}

	return currentCandidates;
}

function resolveSinglePath(
	model: DocumentModel,
	operationIndex: number,
	path: HierarchyLevel[] | undefined,
	unresolvedKind: ResolutionIssue["kind"],
	ambiguousKind: ResolutionIssue["kind"],
	issues: ResolutionIssue[],
	classificationOverrides?: ClassificationOverride[],
	redesignations?: Map<string, string>,
): string | null {
	let normalized = normalizePath(path);

	// Apply classification override if available
	if (
		classificationOverrides &&
		classificationOverrides.length > 0 &&
		path &&
		path.length > 0
	) {
		const sectionSegment = path.find((s) => s.type === "section");
		if (sectionSegment) {
			const matchingOverride = classificationOverrides.find(
				(o) => o.pubLawSec === sectionSegment.val,
			);
			if (matchingOverride?.uscSection) {
				// We found an override, meaning this section is actually classified differently.
				// However, D1 resolution here usually works by matching the label that exists
				// in the document structure.
				// If the document uses the overridden section number, we might want to swap
				// out the segment.val with the overridden one to match nodes in the tree.

				// Keep track if we replaced the section label for resolution purposes
				normalized = normalized.map((s) =>
					s.type === "section"
						? { ...s, val: matchingOverride.uscSection || s.val }
						: s,
				);
			}
		}
	}

	if (normalized.length === 0) return null;
	let candidates = resolvePathCandidates(model, normalized);
	if (candidates.length === 0 && redesignations && redesignations.size > 0) {
		const fullPath = pathToText(normalized);
		for (const [newPath, oldLabel] of redesignations) {
			if (fullPath !== newPath) continue;
			const last = normalized[normalized.length - 1];
			if (!last) break;
			const aliasedPath = [
				...normalized.slice(0, -1),
				{ ...last, val: oldLabel },
			];
			candidates = resolvePathCandidates(model, aliasedPath);
			break;
		}
	}
	if (candidates.length === 0) {
		issues.push({
			operationIndex,
			kind: unresolvedKind,
			path: pathToText(path),
		});
		return null;
	}
	if (candidates.length > 1) {
		issues.push({
			operationIndex,
			kind: ambiguousKind,
			path: pathToText(path),
			candidateNodeIds: candidates,
		});
		return null;
	}
	return candidates[0] ?? null;
}

// --- Tree walk + inline resolution ---

interface TraversalContext {
	target: HierarchyLevel[];
	matterPreceding: StructuralReference | null;
	matterPrecedingTarget: HierarchyLevel[] | null;
	matterFollowingTarget: HierarchyLevel[] | null;
	unanchoredInsertMode: "insert" | "add_at_end";
	sentenceOrdinal: number | null;
	atEndOnly: boolean;
	classificationOverrides?: ClassificationOverride[];
	redesignations: Map<string, string>;
}

interface WalkResult {
	resolved: ResolvedInstructionOperation[];
	issues: ResolutionIssue[];
	unsupportedReasons: string[];
}

function toHierarchyType(kind: ScopeKind): HierarchyLevel["type"] {
	switch (kind) {
		case ScopeKind.Section:
			return "section";
		case ScopeKind.Subsection:
			return "subsection";
		case ScopeKind.Paragraph:
			return "paragraph";
		case ScopeKind.Subparagraph:
			return "subparagraph";
		case ScopeKind.Clause:
			return "clause";
		case ScopeKind.Subclause:
			return "subclause";
		case ScopeKind.Item:
			return "item";
		case ScopeKind.Subitem:
			return "subitem";
	}
}

function refToHierarchyPath(ref: StructuralReference): HierarchyLevel[] {
	return ref.path.map((selector) => ({
		type: toHierarchyType(selector.kind),
		val: selector.label,
	}));
}

function mergeTargets(
	base: HierarchyLevel[],
	override: HierarchyLevel[] | null,
): HierarchyLevel[] {
	if (!override || override.length === 0) return base;

	// Check if the override starts at some point within the base path to avoid duplication.
	for (let i = 0; i < base.length; i++) {
		let match = true;
		for (let j = 0; j + i < base.length && j < override.length; j++) {
			if (
				base[i + j].type !== override[j].type ||
				base[i + j].val !== override[j].val
			) {
				match = false;
				break;
			}
		}
		if (match) {
			// Found an overlap. Check if we should merge.
			// If override is completely contained in base, return base.
			if (i + override.length <= base.length) {
				return base;
			}
			// Otherwise return base prefix + override.
			return [...base.slice(0, i), ...override];
		}
	}

	return [...base, ...override];
}

function targetPathFromEditTarget(target: EditTarget): HierarchyLevel[] | null {
	if ("ref" in target) {
		return refToHierarchyPath(target.ref);
	}
	if ("refs" in target && target.refs.length > 0) {
		const first = target.refs[0];
		return first ? refToHierarchyPath(first) : null;
	}
	return null;
}

function throughTargetPathFromEditTarget(
	target: EditTarget,
): HierarchyLevel[] | null {
	if ("refs" in target && target.refs.length > 1) {
		const last = target.refs[target.refs.length - 1];
		return last ? refToHierarchyPath(last) : null;
	}
	return null;
}

function looksLikeBlockContent(content: string): boolean {
	return /^["""']?\([^)]+\)/.test(content.trim());
}

function resolveEdit(
	model: DocumentModel,
	editNode: EditNode,
	context: TraversalContext,
	counter: { index: number },
	issues: ResolutionIssue[],
): { resolved: ResolvedInstructionOperation[]; unsupportedReasons: string[] } {
	const edit = editNode.edit;
	const targetWithContext = (path: HierarchyLevel[] | null): HierarchyLevel[] =>
		mergeTargets(context.target, path);
	const optionalTargetWithContext = (
		path: HierarchyLevel[] | null,
	): HierarchyLevel[] => (path ? mergeTargets(context.target, path) : []);

	function resolve(
		operationIndex: number,
		path: HierarchyLevel[] | undefined,
		unresolvedKind: ResolutionIssue["kind"],
		ambiguousKind: ResolutionIssue["kind"],
	): string | null {
		return resolveSinglePath(
			model,
			operationIndex,
			path,
			unresolvedKind,
			ambiguousKind,
			issues,
			context.classificationOverrides,
			context.redesignations,
		);
	}

	function makeOp(
		operationIndex: number,
		nodeText: string,
		targetPath: HierarchyLevel[],
		overrides: Partial<
			Pick<
				ResolvedInstructionOperation,
				| "addAtEnd"
				| "redesignateMappingIndex"
				| "resolvedThroughTargetId"
				| "resolvedAnchorTargetId"
				| "resolvedMoveFromIds"
				| "resolvedMoveAnchorId"
			>
		> = {},
	): ResolvedInstructionOperation {
		const normalizedPath = normalizePath(targetPath);
		return {
			operationIndex,
			nodeText,
			edit,
			addAtEnd: overrides.addAtEnd ?? false,
			redesignateMappingIndex: overrides.redesignateMappingIndex ?? 0,
			sentenceOrdinal: context.sentenceOrdinal,
			atEndOnly: context.atEndOnly,
			hasMatterPrecedingTarget: context.matterPrecedingTarget !== null,
			hasMatterFollowingTarget: context.matterFollowingTarget !== null,
			matterPrecedingRefKind: context.matterPreceding?.kind ?? null,
			matterPrecedingRefLabel:
				context.matterPreceding?.path.at(-1)?.label ?? null,
			matterFollowingRefKind: null,
			matterFollowingRefLabel: null,
			hasExplicitTargetPath: normalizedPath.length > 0,
			targetPathText: targetPath.length > 0 ? pathToText(targetPath) : null,
			resolvedTargetId: resolve(
				operationIndex,
				targetPath,
				"target_unresolved",
				"target_ambiguous",
			),
			resolvedMatterPrecedingTargetId: context.matterPrecedingTarget
				? resolve(
						operationIndex,
						context.matterPrecedingTarget,
						"matter_preceding_target_unresolved",
						"matter_preceding_target_ambiguous",
					)
				: null,
			resolvedMatterFollowingTargetId: context.matterFollowingTarget
				? resolve(
						operationIndex,
						context.matterFollowingTarget,
						"matter_following_target_unresolved",
						"matter_following_target_ambiguous",
					)
				: null,
			resolvedThroughTargetId: overrides.resolvedThroughTargetId ?? null,
			resolvedAnchorTargetId: overrides.resolvedAnchorTargetId ?? null,
			resolvedMoveFromIds: overrides.resolvedMoveFromIds ?? [],
			resolvedMoveAnchorId: overrides.resolvedMoveAnchorId ?? null,
		};
	}

	switch (edit.kind) {
		case UltimateEditKind.StrikeInsert: {
			const strikeSearch = textSearchFromEditTarget(edit.strike);
			const strikingContent = strikeSearch?.text ?? null;
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.strike),
			);
			const scopedThroughTarget = optionalTargetWithContext(
				throughTargetPathFromEditTarget(edit.strike),
			);
			if (!strikingContent && scopedTarget.length === 0) {
				return {
					resolved: [],
					unsupportedReasons: ["strike_insert_unsupported_target"],
				};
			}
			const operationIndex = counter.index++;
			const nodeText = context.matterPreceding
				? `in the matter preceding ${context.matterPreceding.kind} (${context.matterPreceding.path.at(-1)?.label ?? ""}), by striking "${strikingContent}" and inserting "${edit.insert.text}"`
				: `by striking "${strikingContent}" and inserting "${edit.insert.text}"`;
			const throughTarget =
				scopedThroughTarget.length > 0 ? scopedThroughTarget : undefined;
			return {
				resolved: [
					makeOp(operationIndex, nodeText, scopedTarget, {
						resolvedThroughTargetId: throughTarget
							? resolve(
									operationIndex,
									throughTarget,
									"through_target_unresolved",
									"through_target_ambiguous",
								)
							: null,
					}),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Strike: {
			const strikeSearch = textSearchFromEditTarget(edit.target);
			const strikingContent = strikeSearch?.text ?? null;
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.target),
			);
			const scopedThroughTarget = optionalTargetWithContext(
				throughTargetPathFromEditTarget(edit.target),
			);
			if (!strikingContent && scopedTarget.length === 0) {
				return {
					resolved: [],
					unsupportedReasons: ["strike_unsupported_target"],
				};
			}
			const operationIndex = counter.index++;
			const throughTarget =
				scopedThroughTarget.length > 0 ? scopedThroughTarget : undefined;
			return {
				resolved: [
					makeOp(
						operationIndex,
						`by striking "${strikingContent}"`,
						scopedTarget,
						{
							resolvedThroughTargetId: throughTarget
								? resolve(
										operationIndex,
										throughTarget,
										"through_target_unresolved",
										"through_target_ambiguous",
									)
								: null,
						},
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Insert: {
			if (edit.before) {
				const anchor = textFromEditTarget(edit.before);
				const anchorTarget = targetPathFromEditTarget(edit.before);
				const scopedAnchorTarget = anchorTarget
					? targetWithContext(anchorTarget)
					: undefined;
				if (!anchor && !scopedAnchorTarget) {
					return {
						resolved: [],
						unsupportedReasons: ["insert_before_unsupported_target"],
					};
				}
				const operationIndex = counter.index++;
				return {
					resolved: [
						makeOp(
							operationIndex,
							`by inserting "${edit.content.text}" before "${anchor ?? "target"}"`,
							context.target,
							{
								resolvedAnchorTargetId: scopedAnchorTarget
									? resolve(
											operationIndex,
											scopedAnchorTarget,
											"anchor_target_unresolved",
											"anchor_target_ambiguous",
										)
									: null,
							},
						),
					],
					unsupportedReasons: [],
				};
			}
			if (edit.after) {
				const anchor = textFromEditTarget(edit.after);
				const anchorTarget = targetPathFromEditTarget(edit.after);
				const scopedAnchorTarget = anchorTarget
					? targetWithContext(anchorTarget)
					: undefined;
				if (!anchor && !scopedAnchorTarget) {
					return {
						resolved: [],
						unsupportedReasons: ["insert_after_unsupported_target"],
					};
				}
				const operationIndex = counter.index++;
				return {
					resolved: [
						makeOp(
							operationIndex,
							`by inserting "${edit.content.text}" after "${anchor ?? "target"}"`,
							context.target,
							{
								resolvedAnchorTargetId: scopedAnchorTarget
									? resolve(
											operationIndex,
											scopedAnchorTarget,
											"anchor_target_unresolved",
											"anchor_target_ambiguous",
										)
									: null,
							},
						),
					],
					unsupportedReasons: [],
				};
			}
			const addAtEnd =
				edit.atEndOf !== undefined ||
				context.unanchoredInsertMode === "add_at_end" ||
				looksLikeBlockContent(edit.content.text);
			const target = edit.atEndOf
				? targetWithContext(refToHierarchyPath(edit.atEndOf))
				: context.target;
			const operationIndex = counter.index++;
			return {
				resolved: [
					makeOp(
						operationIndex,
						addAtEnd ? "by adding at the end the following" : "by inserting",
						target,
						{ addAtEnd },
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Rewrite: {
			const target = edit.target
				? targetWithContext(refToHierarchyPath(edit.target))
				: context.target;
			const operationIndex = counter.index++;
			return {
				resolved: [makeOp(operationIndex, "to read as follows:", target)],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Redesignate: {
			const results: ResolvedInstructionOperation[] = [];
			for (let i = 0; i < edit.mappings.length; i++) {
				const mapping = edit.mappings[i];
				if (!mapping) continue;
				const fromPath = targetWithContext(refToHierarchyPath(mapping.from));
				const fromLabel =
					mapping.from.path[mapping.from.path.length - 1]?.label ?? "";
				const toLabel =
					mapping.to.path[mapping.to.path.length - 1]?.label ?? "";
				const operationIndex = counter.index++;
				results.push(
					makeOp(
						operationIndex,
						`redesignating ${fromLabel} as ${toLabel}`,
						fromPath,
						{
							redesignateMappingIndex: i,
						},
					),
				);
			}
			return { resolved: results, unsupportedReasons: [] };
		}
		case UltimateEditKind.Move: {
			const fromTargets = edit.from.map((ref) =>
				targetWithContext(refToHierarchyPath(ref)),
			);
			const beforeTarget = edit.before
				? targetWithContext(refToHierarchyPath(edit.before))
				: undefined;
			const afterTarget = edit.after
				? targetWithContext(refToHierarchyPath(edit.after))
				: undefined;
			if (fromTargets.length === 0 || (!beforeTarget && !afterTarget)) {
				return {
					resolved: [],
					unsupportedReasons: ["move_unsupported_target"],
				};
			}
			const operationIndex = counter.index++;
			const resolvedMoveFromIds = fromTargets.map((fromTarget) =>
				resolve(
					operationIndex,
					fromTarget,
					"move_from_unresolved",
					"move_from_ambiguous",
				),
			);
			const moveAnchorTarget = afterTarget ?? beforeTarget;
			const resolvedMoveAnchorId = resolve(
				operationIndex,
				moveAnchorTarget,
				"move_anchor_unresolved",
				"move_anchor_ambiguous",
			);
			return {
				resolved: [
					{
						operationIndex,
						nodeText: "moving target block",
						edit,
						addAtEnd: false,
						redesignateMappingIndex: 0,
						sentenceOrdinal: null,
						atEndOnly: false,
						hasMatterPrecedingTarget: false,
						hasMatterFollowingTarget: false,
						matterPrecedingRefKind: null,
						matterPrecedingRefLabel: null,
						matterFollowingRefKind: null,
						matterFollowingRefLabel: null,
						hasExplicitTargetPath: false,
						targetPathText: null,
						resolvedTargetId: null,
						resolvedMatterPrecedingTargetId: null,
						resolvedMatterFollowingTargetId: null,
						resolvedThroughTargetId: null,
						resolvedAnchorTargetId: null,
						resolvedMoveFromIds,
						resolvedMoveAnchorId,
					},
				],
				unsupportedReasons: [],
			};
		}
	}
}

export function walkTree(
	model: DocumentModel,
	nodes: InstructionSemanticTree["children"],
	context: TraversalContext,
	counter: { index: number },
): WalkResult {
	const resolved: ResolvedInstructionOperation[] = [];
	const issues: ResolutionIssue[] = [];
	const unsupportedReasons: string[] = [];

	for (const node of nodes) {
		if (node.type === SemanticNodeType.Scope) {
			const scopeTarget = mergeTargets(context.target, [
				{ type: toHierarchyType(node.scope.kind), val: node.scope.label },
			]);
			const nested = walkTree(
				model,
				node.children,
				{ ...context, target: scopeTarget },
				counter,
			);
			resolved.push(...nested.resolved);
			issues.push(...nested.issues);
			unsupportedReasons.push(...nested.unsupportedReasons);
			// Carry redesignations from nested scopes?
			// Usually redesignations are local to the level they are in.
			continue;
		}

		if (node.type === SemanticNodeType.LocationRestriction) {
			if (node.restriction.kind === LocationRestrictionKind.In) {
				if (node.restriction.refs.length === 0) {
					unsupportedReasons.push("in_location_empty_refs");
					continue;
				}
				for (const ref of node.restriction.refs) {
					const target = mergeTargets(context.target, refToHierarchyPath(ref));
					const nested = walkTree(
						model,
						node.children,
						{ ...context, target },
						counter,
					);
					resolved.push(...nested.resolved);
					issues.push(...nested.issues);
					unsupportedReasons.push(...nested.unsupportedReasons);
				}
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterPreceding) {
				const matterPrecedingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				const nested = walkTree(
					model,
					node.children,
					{
						...context,
						matterPreceding: node.restriction.ref,
						matterPrecedingTarget,
					},
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.AtEnd) {
				const target = mergeTargets(
					context.target,
					node.restriction.ref
						? refToHierarchyPath(node.restriction.ref)
						: null,
				);
				const nested = walkTree(
					model,
					node.children,
					{
						...context,
						target,
						unanchoredInsertMode: "add_at_end",
						atEndOnly: true,
					},
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceOrdinal) {
				const nested = walkTree(
					model,
					node.children,
					{ ...context, sentenceOrdinal: node.restriction.ordinal },
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceLast) {
				const nested = walkTree(
					model,
					node.children,
					{ ...context, sentenceOrdinal: -1 },
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterFollowing) {
				const matterFollowingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				const nested = walkTree(
					model,
					node.children,
					{ ...context, matterFollowingTarget },
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}

			unsupportedReasons.push(
				`location_${node.restriction.kind}_not_supported`,
			);
			continue;
		}

		if (node.type === SemanticNodeType.Edit) {
			const nested = resolveEdit(model, node, context, counter, issues);
			resolved.push(...nested.resolved);
			unsupportedReasons.push(...nested.unsupportedReasons);

			// Track redesignations to handle "(as so redesignated)" references in subsequent edits
			for (const op of nested.resolved) {
				if (op.edit.kind === UltimateEditKind.Redesignate) {
					const mapping = op.edit.mappings[op.redesignateMappingIndex];
					if (mapping) {
						const toHierarchy = refToHierarchyPath(mapping.to);
						const fullToPath = pathToText(
							normalizePath(mergeTargets(context.target, toHierarchy)),
						);
						const fromLabel =
							mapping.from.path[mapping.from.path.length - 1]?.label;
						if (fullToPath && fromLabel) {
							context.redesignations.set(fullToPath, fromLabel);
						}
					}
				}
			}
		}
	}

	return { resolved, issues, unsupportedReasons };
}

interface SequentialExecutionState {
	resolutionModel: DocumentModel;
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
			if (deletedMask[index] === 1) continue;
			if (liveCount === target) return index;
			liveCount += 1;
		}
		return renderText.length;
	};

	return { toRenderPoint };
}

function toSpanOnlyModel(
	plainText: string,
	spans: FormattingSpan[],
): DocumentModel {
	return {
		plainText,
		spans,
		rootRange: { start: 0, end: plainText.length, targetLevel: 0 },
		nodesById: new Map(),
		rootNodeIds: [],
	};
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
	const nextResolutionText = applyPlannedPatchesToWorkingText(
		state.resolutionModel.plainText,
		orderedPatches,
	);
	state.resolutionModel = buildAmendmentDocumentModel(nextResolutionText);
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
	state.patches.push(...orderedPatches);
	return orderedPatches;
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

function executeTreeSequential(
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
			executeTreeSequential(
				node.children,
				{ ...context, target: scopeTarget },
				counter,
				state,
			);
			continue;
		}

		if (node.type === SemanticNodeType.LocationRestriction) {
			if (node.restriction.kind === LocationRestrictionKind.In) {
				if (node.restriction.refs.length === 0) {
					state.unsupportedReasons.push("in_location_empty_refs");
					continue;
				}
				for (const ref of node.restriction.refs) {
					const target = mergeTargets(context.target, refToHierarchyPath(ref));
					executeTreeSequential(
						node.children,
						{ ...context, target },
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
					{ ...context, sentenceOrdinal: node.restriction.ordinal },
					counter,
					state,
				);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceLast) {
				executeTreeSequential(
					node.children,
					{ ...context, sentenceOrdinal: -1 },
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
					{ ...context, matterFollowingTarget },
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

// --- Apply summary / debug helpers ---

function mapIssueToFailureReason(
	issue: ResolutionIssue | undefined,
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">,
): {
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
} {
	if (issue) {
		const hasCandidates =
			issue.candidateNodeIds !== undefined && issue.candidateNodeIds.length > 0;
		if (issue.kind.endsWith("_ambiguous")) {
			return {
				reasonKind: "target_ambiguous",
				reason: "Target path was ambiguous.",
				reasonDetail: hasCandidates
					? `${issue.path} [candidates=${issue.candidateNodeIds?.join(", ")}]`
					: issue.path,
			};
		}
		return {
			reasonKind: "target_unresolved",
			reason: "Target path did not resolve.",
			reasonDetail: issue.path,
		};
	}
	if (outcome === "scope_unresolved") {
		return {
			reasonKind: "scope_unresolved",
			reason: "Scope could not be resolved.",
			reasonDetail: null,
		};
	}
	return {
		reasonKind: "no_match",
		reason: "No matching text or anchor found in resolved scope.",
		reasonDetail: null,
	};
}

function buildApplySummary(
	operationAttempts: OperationMatchAttempt[],
	resolutionIssues: ResolutionIssue[],
): AmendmentApplySummary {
	const issueByOperationIndex = new Map<number, ResolutionIssue>();
	for (const issue of resolutionIssues) {
		if (!issueByOperationIndex.has(issue.operationIndex)) {
			issueByOperationIndex.set(issue.operationIndex, issue);
		}
	}
	const failedItems: FailedApplyItem[] = [];
	for (
		let operationIndex = 0;
		operationIndex < operationAttempts.length;
		operationIndex += 1
	) {
		const attempt = operationAttempts[operationIndex];
		if (!attempt || attempt.outcome === "applied") continue;
		const failure = mapIssueToFailureReason(
			issueByOperationIndex.get(operationIndex),
			attempt.outcome,
		);
		failedItems.push({
			operationIndex,
			operationType: attempt.operationType,
			text: attempt.nodeText,
			outcome: attempt.outcome,
			targetPath: attempt.targetPath,
			reasonKind: failure.reasonKind,
			reason: failure.reason,
			reasonDetail: failure.reasonDetail,
			wasTranslated: attempt.wasTranslated,
			translatedInstructionText: attempt.translatedInstructionText,
		});
	}
	return {
		partiallyApplied: failedItems.length > 0,
		failedItems,
		wasTranslated: operationAttempts.some((a) => a.wasTranslated),
	};
}

function makeUnsupportedResult(
	args: ApplyEditTreeArgs,
	renderModel: { plainText: string; spans: FormattingSpan[] },
	operationCount: number,
	operationAttempts: OperationMatchAttempt[],
	reason: string,
	pipeline?: {
		resolvedOperationCount: number;
		plannedPatchCount: number;
		resolutionIssues: ResolutionIssue[];
	},
): AmendmentEffect {
	const resolvedOperationCount = pipeline?.resolvedOperationCount ?? 0;
	const plannedPatchCount = pipeline?.plannedPatchCount ?? 0;
	const resolutionIssues = pipeline?.resolutionIssues ?? [];
	const applySummary = buildApplySummary(operationAttempts, resolutionIssues);
	return {
		status: "unsupported",
		sectionPath: args.sectionPath,
		renderModel,
		segments: [{ kind: "unchanged", text: args.sectionBody }],
		changes: [],
		deleted: [],
		inserted: [],
		annotatedHtml: renderMarkdown(args.sectionBody),
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount,
			operationAttempts,
			failureReason: reason,
			pipeline: {
				resolvedOperationCount,
				plannedPatchCount,
				resolutionIssueCount: resolutionIssues.length,
				resolutionIssues,
			},
		},
	};
}

export function applyAmendmentEditTreeToSection(
	args: ApplyEditTreeArgs,
): AmendmentEffect {
	const initialModel = buildAmendmentDocumentModel(
		args.sectionBody,
		args.parsedDocument,
	);
	const counter = { index: 0 };
	const execution: SequentialExecutionState = {
		resolutionModel: initialModel,
		renderPlainText: initialModel.plainText,
		renderSpans: initialModel.spans,
		resolvedOperationCount: 0,
		patches: [],
		attempts: [],
		issues: [],
		unsupportedReasons: [],
	};
	executeTreeSequential(
		args.tree.children,
		{
			target: [],
			matterPreceding: null,
			matterPrecedingTarget: null,
			matterFollowingTarget: null,
			unanchoredInsertMode: /\badding at the end\b/i.test(
				args.instructionText ?? "",
			)
				? "add_at_end"
				: "insert",
			sentenceOrdinal: null,
			atEndOnly: false,
			classificationOverrides: args.classificationOverrides,
			redesignations: new Map(),
		},
		counter,
		execution,
	);

	if (execution.resolvedOperationCount === 0) {
		return makeUnsupportedResult(
			args,
			{ plainText: initialModel.plainText, spans: initialModel.spans },
			0,
			[],
			execution.unsupportedReasons[0] ?? "no_edit_tree_operations",
			{ resolvedOperationCount: 0, plannedPatchCount: 0, resolutionIssues: [] },
		);
	}

	const patches = execution.patches;
	const attempts = execution.attempts;
	const workingText = execution.renderPlainText;

	const changes = patches.map((patch) => ({
		deleted: patch.deletedPlain,
		inserted: `${patch.insertedPrefixPlain ?? ""}${patch.insertedPlain}${
			patch.insertedSuffixPlain ?? ""
		}`,
	}));
	const deleted = patches
		.map((patch) => patch.deletedPlain)
		.filter((value) => value.length > 0);
	const inserted = patches
		.map(
			(patch) =>
				`${patch.insertedPrefixPlain ?? ""}${patch.insertedPlain}${
					patch.insertedSuffixPlain ?? ""
				}`,
		)
		.filter((value) => value.length > 0);
	const applySummary = buildApplySummary(attempts, execution.issues);

	if (changes.length === 0) {
		return makeUnsupportedResult(
			args,
			{ plainText: initialModel.plainText, spans: initialModel.spans },
			execution.resolvedOperationCount,
			attempts,
			execution.unsupportedReasons[0] ??
				execution.issues[0]?.kind ??
				"no_patches_applied",
			{
				resolvedOperationCount: execution.resolvedOperationCount,
				plannedPatchCount: patches.length,
				resolutionIssues: execution.issues,
			},
		);
	}

	return {
		status: "ok",
		sectionPath: args.sectionPath,
		renderModel: {
			plainText: execution.renderPlainText,
			spans: execution.renderSpans,
		},
		segments: [{ kind: "unchanged", text: workingText }],
		changes,
		deleted,
		inserted,
		annotatedHtml: renderMarkdown(workingText),
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount: execution.resolvedOperationCount,
			operationAttempts: attempts,
			failureReason: null,
			pipeline: {
				resolvedOperationCount: execution.resolvedOperationCount,
				plannedPatchCount: patches.length,
				resolutionIssueCount: execution.issues.length,
				resolutionIssues: execution.issues,
			},
		},
	};
}
