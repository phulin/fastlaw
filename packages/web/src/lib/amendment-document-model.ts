import type {
	DocumentModel,
	HierarchyLevel,
	HierarchyLevelType,
	ScopeRange,
	StructuralNode,
} from "./amendment-edit-engine-types";
import { ScopeKind } from "./amendment-edit-tree";
import {
	type HierarchyNode,
	parseMarkdownHierarchy,
} from "./markdown-hierarchy-parser";

function getLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function rankToHierarchyType(rank: number): HierarchyLevelType {
	switch (rank) {
		case 1:
			return ScopeKind.Subsection;
		case 2:
			return ScopeKind.Paragraph;
		case 3:
			return ScopeKind.Subparagraph;
		case 4:
			return ScopeKind.Clause;
		case 5:
			return ScopeKind.Subclause;
		case 6:
			return ScopeKind.Item;
		default:
			return ScopeKind.Subitem;
	}
}

function buildPath(
	parentPath: HierarchyLevel[],
	kind: HierarchyLevelType,
	label: string,
): HierarchyLevel[] {
	return [...parentPath, { type: kind, val: label }];
}

function deriveKindFromLevel(level: number): HierarchyLevelType {
	const rank = level % 10;
	const normalizedRank = rank === 0 ? 1 : rank;
	return rankToHierarchyType(normalizedRank);
}

function targetLevelFromNode(node: HierarchyNode): number {
	return Math.floor(node.level / 10);
}

function scopeRangeFromNode(
	sourceText: string,
	lineStarts: number[],
	node: HierarchyNode,
	paragraphLineStarts: number[],
): ScopeRange | null {
	const startLine = paragraphLineStarts[node.startParagraph];
	const endLine = paragraphLineStarts[node.endParagraph];
	if (typeof startLine !== "number") return null;
	const start = lineStarts[startLine] ?? 0;
	const end =
		typeof endLine === "number"
			? (lineStarts[endLine] ?? sourceText.length)
			: sourceText.length;
	return {
		start,
		end,
		targetLevel: targetLevelFromNode(node),
	};
}

interface BuildNodesArgs {
	sourceText: string;
	lineStarts: number[];
	paragraphLineStarts: number[];
	nodes: HierarchyNode[];
	parentPath: HierarchyLevel[];
	nodesById: Map<string, StructuralNode>;
}

function buildNodes(args: BuildNodesArgs): string[] {
	const builtNodeIds: string[] = [];
	const siblingCounts = new Map<string, number>();

	for (const node of args.nodes) {
		const kind = deriveKindFromLevel(node.level);
		const labelLower = node.marker.toLowerCase();
		const siblingKey = `${kind}:${labelLower}`;
		const siblingCount = (siblingCounts.get(siblingKey) ?? 0) + 1;
		siblingCounts.set(siblingKey, siblingCount);

		const idPath = [...args.parentPath, { type: kind, val: node.marker }]
			.map((segment) => `${segment.type}:${segment.val.toLowerCase()}`)
			.join("/");
		const nodeId = `${idPath}#${siblingCount}`;

		const range = scopeRangeFromNode(
			args.sourceText,
			args.lineStarts,
			node,
			args.paragraphLineStarts,
		);
		if (!range) continue;

		const path = buildPath(args.parentPath, kind, node.marker);
		const structuralNode: StructuralNode = {
			id: nodeId,
			kind,
			label: node.marker,
			path,
			start: range.start,
			end: range.end,
			targetLevel: range.targetLevel ?? 0,
			childIds: [],
		};
		args.nodesById.set(nodeId, structuralNode);
		builtNodeIds.push(nodeId);

		const childIds = buildNodes({
			sourceText: args.sourceText,
			lineStarts: args.lineStarts,
			paragraphLineStarts: args.paragraphLineStarts,
			nodes: node.sublevels,
			parentPath: path,
			nodesById: args.nodesById,
		});
		const current = args.nodesById.get(nodeId);
		if (current) {
			current.childIds = childIds;
		}
	}

	return builtNodeIds;
}

export function buildAmendmentDocumentModel(sourceText: string): DocumentModel {
	const parsed = parseMarkdownHierarchy(sourceText);
	const lineStarts = getLineStarts(sourceText);
	const paragraphLineStarts = parsed.paragraphs.map(
		(paragraph) => paragraph.startLine,
	);

	const nodesById = new Map<string, StructuralNode>();
	const rootNodeIds = buildNodes({
		sourceText,
		lineStarts,
		paragraphLineStarts,
		nodes: parsed.levels,
		parentPath: [],
		nodesById,
	});

	return {
		sourceText,
		rootRange: {
			start: 0,
			end: sourceText.length,
			targetLevel: null,
		},
		nodesById,
		rootNodeIds,
	};
}

export function getScopeRangeFromNodeId(
	model: DocumentModel,
	nodeId: string | null,
): ScopeRange | null {
	if (nodeId === null) return model.rootRange;
	const node = model.nodesById.get(nodeId);
	if (!node) return null;
	return {
		start: node.start,
		end: node.end,
		targetLevel: node.targetLevel,
	};
}
