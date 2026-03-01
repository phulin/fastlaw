import type {
	CanonicalDocument,
	ClassificationOverride,
	HierarchyLevel,
	ResolutionIssue,
	ResolvedInstructionOperation,
	StructuralNode,
} from "../amendment-edit-engine-types";
import {
	type EditNode,
	type EditTarget,
	type InnerLocationTarget,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	ScopeKind,
	SemanticNodeType,
	type StructuralReference,
	textFromEditTarget,
	textSearchFromEditTarget,
	UltimateEditKind,
} from "../amendment-edit-tree";

// --- Resolver helpers ---

export function pathToText(path: HierarchyLevel[] | undefined): string {
	if (!path || path.length === 0) return "";
	return path.map((segment) => `${segment.type}:${segment.val}`).join(" > ");
}

export function normalizePath(
	path: HierarchyLevel[] | undefined,
): HierarchyLevel[] {
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
	model: CanonicalDocument,
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

function collectDescendantIds(
	model: CanonicalDocument,
	nodeId: string,
): string[] {
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
	model: CanonicalDocument,
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
	model: CanonicalDocument,
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

export interface TraversalContext {
	target: HierarchyLevel[];
	scopeContextTexts: string[];
	matterPreceding: StructuralReference | null;
	matterPrecedingTarget: HierarchyLevel[] | null;
	matterFollowingTarget: HierarchyLevel[] | null;
	beforeInnerTarget?: InnerLocationTarget | null;
	afterInnerTarget?: InnerLocationTarget | null;
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

export function toHierarchyType(kind: ScopeKind): HierarchyLevel["type"] {
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

export function refToHierarchyPath(ref: StructuralReference): HierarchyLevel[] {
	return ref.path.map((selector) => ({
		type: toHierarchyType(selector.kind),
		val: selector.label,
	}));
}

function describeInsertAnchor(anchor: string | null): string {
	return anchor ? `"${anchor}"` : "the specified target";
}

export function mergeTargets(
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

export function appendScopeContextText(
	texts: string[],
	text: string | undefined,
): string[] {
	const trimmed = text?.trim();
	if (!trimmed) return texts;
	if (texts[texts.length - 1] === trimmed) return texts;
	return [...texts, trimmed];
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

function throughTargetPathFromExplicitTarget(
	target: EditTarget,
): HierarchyLevel[] | null {
	if ("ref" in target) {
		return refToHierarchyPath(target.ref);
	}
	return throughTargetPathFromEditTarget(target);
}

function looksLikeBlockContent(content: string): boolean {
	return /^["""']?\([^)]+\)/.test(content.trim());
}

export function resolveEdit(
	model: CanonicalDocument,
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
				| "structuralStrikeMode"
				| "resolvedStructuralTargetIds"
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
			originalNodeText: editNode.sourceText?.trim() || null,
			scopeContextTexts: context.scopeContextTexts,
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
			beforeInnerTarget: context.beforeInnerTarget ?? null,
			afterInnerTarget: context.afterInnerTarget ?? null,
			structuralStrikeMode: overrides.structuralStrikeMode ?? null,
			resolvedStructuralTargetIds: overrides.resolvedStructuralTargetIds ?? [],
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
			const scopedThroughTarget = edit.through
				? optionalTargetWithContext(
						throughTargetPathFromExplicitTarget(edit.through),
					)
				: optionalTargetWithContext(
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
			const scopedThroughTarget = edit.through
				? optionalTargetWithContext(
						throughTargetPathFromExplicitTarget(edit.through),
					)
				: optionalTargetWithContext(
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
			const structuralTargets =
				!strikingContent && "refs" in edit.target && edit.target.refs.length > 1
					? edit.target.refs.map((ref) =>
							targetWithContext(refToHierarchyPath(ref)),
						)
					: [];
			const resolvedStructuralTargetIds =
				structuralTargets.length > 0
					? structuralTargets.map((target) =>
							resolve(
								operationIndex,
								target,
								"target_unresolved",
								"target_ambiguous",
							),
						)
					: [];
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
							structuralStrikeMode: edit.structuralMode ?? null,
							resolvedStructuralTargetIds,
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
							`by inserting "${edit.content.text}" before ${describeInsertAnchor(anchor)}`,
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
							`by inserting "${edit.content.text}" after ${describeInsertAnchor(anchor)}`,
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
						originalNodeText: editNode.sourceText?.trim() || null,
						scopeContextTexts: context.scopeContextTexts,
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
						structuralStrikeMode: null,
						resolvedStructuralTargetIds: [],
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
	model: CanonicalDocument,
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
			const scopeContextTexts = appendScopeContextText(
				context.scopeContextTexts,
				node.sourceText,
			);
			const nested = walkTree(
				model,
				node.children,
				{ ...context, target: scopeTarget, scopeContextTexts },
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
			const scopeContextTexts = appendScopeContextText(
				context.scopeContextTexts,
				node.sourceText,
			);
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
						{ ...context, target, scopeContextTexts },
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
						scopeContextTexts,
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
						scopeContextTexts,
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
					{
						...context,
						scopeContextTexts,
						sentenceOrdinal: node.restriction.ordinal,
					},
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
					{ ...context, scopeContextTexts, sentenceOrdinal: -1 },
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
					{ ...context, scopeContextTexts, matterFollowingTarget },
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.Before) {
				const nested = walkTree(
					model,
					node.children,
					{
						...context,
						scopeContextTexts,
						beforeInnerTarget: node.restriction.target,
					},
					counter,
				);
				resolved.push(...nested.resolved);
				issues.push(...nested.issues);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.After) {
				const nested = walkTree(
					model,
					node.children,
					{
						...context,
						scopeContextTexts,
						afterInnerTarget: node.restriction.target,
					},
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
