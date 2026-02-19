import type {
	DocumentModel,
	HierarchyLevel,
	InstructionNode,
	InstructionOperation,
	ResolutionIssue,
	ResolvedInstructionOperation,
	StructuralNode,
} from "./amendment-edit-engine-types";

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
	const normalized = normalizePath(path);
	if (normalized.length === 0) return [];
	const [firstSegment, ...rest] = normalized;
	if (!firstSegment) return [];
	let currentCandidates = filterCandidateIds(
		model,
		model.rootNodeIds,
		firstSegment,
	);
	for (const segment of rest) {
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
		if (currentCandidates.length === 0) return [];
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
): string | null {
	const normalized = normalizePath(path);
	if (normalized.length === 0) return null;
	const candidates = resolvePathCandidates(model, normalized);
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

function getTargetPath(
	operation: InstructionOperation,
): HierarchyLevel[] | undefined {
	if ("target" in operation) return operation.target;
	return undefined;
}

export function resolveInstructionOperations(
	model: DocumentModel,
	nodes: InstructionNode[],
): {
	resolved: ResolvedInstructionOperation[];
	issues: ResolutionIssue[];
} {
	const issues: ResolutionIssue[] = [];
	const resolved: ResolvedInstructionOperation[] = [];

	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!node) continue;
		const operation = node.operation;
		const targetPath = getTargetPath(operation);
		const normalizedTargetPath = normalizePath(targetPath);
		const targetPathText =
			targetPath && targetPath.length > 0 ? pathToText(targetPath) : null;
		const hasExplicitTargetPath = normalizedTargetPath.length > 0;
		const resolvedTargetId = resolveSinglePath(
			model,
			index,
			targetPath,
			"target_unresolved",
			"target_ambiguous",
			issues,
		);

		let resolvedMatterPrecedingTargetId: string | null = null;
		if (
			"matterPrecedingTarget" in operation &&
			operation.matterPrecedingTarget
		) {
			resolvedMatterPrecedingTargetId = resolveSinglePath(
				model,
				index,
				operation.matterPrecedingTarget,
				"matter_preceding_target_unresolved",
				"matter_preceding_target_ambiguous",
				issues,
			);
		}

		let resolvedMatterFollowingTargetId: string | null = null;
		if (
			"matterFollowingTarget" in operation &&
			operation.matterFollowingTarget
		) {
			resolvedMatterFollowingTargetId = resolveSinglePath(
				model,
				index,
				operation.matterFollowingTarget,
				"matter_following_target_unresolved",
				"matter_following_target_ambiguous",
				issues,
			);
		}

		let resolvedThroughTargetId: string | null = null;
		if ("throughTarget" in operation && operation.throughTarget) {
			resolvedThroughTargetId = resolveSinglePath(
				model,
				index,
				operation.throughTarget,
				"through_target_unresolved",
				"through_target_ambiguous",
				issues,
			);
		}

		let resolvedAnchorTargetId: string | null = null;
		if (
			("anchorTarget" in operation && operation.anchorTarget) ||
			operation.type === "insert_before" ||
			operation.type === "insert_after"
		) {
			const anchorPath =
				"anchorTarget" in operation ? operation.anchorTarget : undefined;
			if (anchorPath) {
				resolvedAnchorTargetId = resolveSinglePath(
					model,
					index,
					anchorPath,
					"anchor_target_unresolved",
					"anchor_target_ambiguous",
					issues,
				);
			}
		}

		const resolvedMoveFromIds: Array<string | null> = [];
		let resolvedMoveAnchorId: string | null = null;
		if (operation.type === "move") {
			for (const fromTarget of operation.fromTargets) {
				const fromId = resolveSinglePath(
					model,
					index,
					fromTarget,
					"move_from_unresolved",
					"move_from_ambiguous",
					issues,
				);
				resolvedMoveFromIds.push(fromId);
			}
			const moveAnchorTarget = operation.afterTarget ?? operation.beforeTarget;
			resolvedMoveAnchorId = resolveSinglePath(
				model,
				index,
				moveAnchorTarget,
				"move_anchor_unresolved",
				"move_anchor_ambiguous",
				issues,
			);
		}

		resolved.push({
			operationIndex: index,
			nodeText: node.text,
			operation,
			hasExplicitTargetPath,
			targetPathText,
			resolvedTargetId,
			resolvedMatterPrecedingTargetId,
			resolvedMatterFollowingTargetId,
			resolvedThroughTargetId,
			resolvedAnchorTargetId,
			resolvedMoveFromIds,
			resolvedMoveAnchorId,
		});
	}

	return { resolved, issues };
}
