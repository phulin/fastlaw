import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node, Parent } from "unist";
import type {
	CanonicalDocument,
	DocumentParagraph,
	FormattingSpan,
	HierarchyLevel,
	HierarchyLevelType,
	ScopeRange,
	StructuralNode,
} from "./amendment-edit-engine-types";
import { ScopeKind } from "./amendment-edit-tree";
import {
	buildHierarchyFromParagraphs,
	extractLeadingLabels,
	type HierarchyNode,
	type ParsedParagraph,
} from "./markdown-hierarchy-parser";

const parseProcessor = unified().use(remarkParse).use(remarkGfm);

export interface ParsedMarkdownDocument {
	plainText: string;
	spans: FormattingSpan[];
	sourceToPlainOffsets: number[];
}

interface SourcePlainSegment {
	sourceStart: number;
	sourceEnd: number;
	plainStart: number;
	plainEnd: number;
}

function nodeOffsets(node: Node): { start: number; end: number } | null {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	if (typeof start !== "number" || typeof end !== "number") return null;
	if (end < start) return null;
	return { start, end };
}

function addSpan(
	spans: FormattingSpan[],
	span: Omit<FormattingSpan, "metadata"> & {
		metadata?: Record<string, unknown>;
	},
): void {
	if (span.end <= span.start) return;
	spans.push(span);
}

function renderInlineNode(
	node: Node,
	state: {
		plainParts: string[];
		plainLength: number;
		spans: FormattingSpan[];
		segments: SourcePlainSegment[];
	},
): void {
	switch (node.type) {
		case "text": {
			const value = (node as Node & { value?: string }).value ?? "";
			if (value.length === 0) return;
			const start = state.plainLength;
			state.plainParts.push(value);
			state.plainLength += value.length;
			const offsets = nodeOffsets(node);
			if (offsets) {
				state.segments.push({
					sourceStart: offsets.start,
					sourceEnd: offsets.end,
					plainStart: start,
					plainEnd: state.plainLength,
				});
			}
			return;
		}
		case "inlineCode": {
			const value = (node as Node & { value?: string }).value ?? "";
			const start = state.plainLength;
			if (value.length > 0) {
				state.plainParts.push(value);
				state.plainLength += value.length;
			}
			const end = state.plainLength;
			addSpan(state.spans, { start, end, type: "inlineCode" });
			const offsets = nodeOffsets(node);
			if (offsets && end > start) {
				state.segments.push({
					sourceStart: offsets.start,
					sourceEnd: offsets.end,
					plainStart: start,
					plainEnd: end,
				});
			}
			return;
		}
		case "break": {
			const start = state.plainLength;
			state.plainParts.push("\n");
			state.plainLength += 1;
			const offsets = nodeOffsets(node);
			if (offsets) {
				state.segments.push({
					sourceStart: offsets.start,
					sourceEnd: offsets.end,
					plainStart: start,
					plainEnd: state.plainLength,
				});
			}
			return;
		}
		case "strong":
		case "emphasis":
		case "delete":
		case "link": {
			const start = state.plainLength;
			const parent = node as Parent;
			for (const child of parent.children ?? []) {
				renderInlineNode(child, state);
			}
			const end = state.plainLength;
			if (node.type === "strong") {
				addSpan(state.spans, { start, end, type: "strong" });
			} else if (node.type === "emphasis") {
				addSpan(state.spans, { start, end, type: "emphasis" });
			} else if (node.type === "delete") {
				addSpan(state.spans, { start, end, type: "delete" });
			} else {
				const href = (node as Node & { url?: string }).url;
				addSpan(state.spans, {
					start,
					end,
					type: "link",
					metadata: href ? { href } : undefined,
				});
			}
			return;
		}
		default: {
			const parent = node as Parent;
			if (!Array.isArray(parent.children)) return;
			for (const child of parent.children) {
				renderInlineNode(child, state);
			}
		}
	}
}

function addBlock(
	node: RootContent,
	quoteDepth: number,
	state: {
		plainParts: string[];
		plainLength: number;
		spans: FormattingSpan[];
		segments: SourcePlainSegment[];
		blockCount: number;
	},
): void {
	if (state.blockCount > 0) {
		state.plainParts.push("\n");
		state.plainLength += 1;
	}
	state.blockCount += 1;

	const start = state.plainLength;
	if (node.type === "code") {
		const value = node.value ?? "";
		if (value.length > 0) {
			state.plainParts.push(value);
			state.plainLength += value.length;
		}
		const offsets = nodeOffsets(node);
		if (offsets && value.length > 0) {
			state.segments.push({
				sourceStart: offsets.start,
				sourceEnd: offsets.end,
				plainStart: start,
				plainEnd: state.plainLength,
			});
		}
	} else {
		const parent = node as Parent;
		for (const child of parent.children ?? []) {
			renderInlineNode(child, state);
		}
	}
	const end = state.plainLength;

	addSpan(state.spans, {
		start,
		end,
		type: "paragraph",
		metadata: { quoteDepth },
	});
	if (node.type === "heading") {
		addSpan(state.spans, {
			start,
			end,
			type: "heading",
			metadata: { depth: node.depth },
		});
	}
}

function walkBlocks(
	nodes: RootContent[],
	quoteDepth: number,
	state: {
		plainParts: string[];
		plainLength: number;
		spans: FormattingSpan[];
		segments: SourcePlainSegment[];
		blockCount: number;
	},
): void {
	for (const node of nodes) {
		if (node.type === "blockquote") {
			walkBlocks(node.children ?? [], quoteDepth + 1, state);
			continue;
		}
		if (node.type === "list") {
			for (const item of node.children ?? []) {
				walkBlocks(
					(item as Parent).children as RootContent[],
					quoteDepth,
					state,
				);
			}
			continue;
		}
		if (node.type === "thematicBreak") {
			addBlock(
				{ type: "paragraph", children: [{ type: "text", value: "---" }] },
				quoteDepth,
				state,
			);
			continue;
		}
		if (node.type === "table") {
			for (const row of node.children ?? []) {
				const rowParts: string[] = [];
				for (const cell of (row as Parent).children ?? []) {
					const cellState = {
						plainParts: [] as string[],
						plainLength: 0,
						spans: [] as FormattingSpan[],
						segments: [] as SourcePlainSegment[],
					};
					for (const child of (cell as Parent).children ?? []) {
						renderInlineNode(child, cellState);
					}
					rowParts.push(cellState.plainParts.join(""));
				}
				addBlock(
					{
						type: "paragraph",
						children: [{ type: "text", value: rowParts.join(" | ") }],
					},
					quoteDepth,
					state,
				);
			}
			continue;
		}
		if (
			node.type === "paragraph" ||
			node.type === "heading" ||
			node.type === "code"
		) {
			addBlock(node, quoteDepth, state);
			continue;
		}
		const parent = node as Parent;
		if (Array.isArray(parent.children)) {
			walkBlocks(parent.children as RootContent[], quoteDepth, state);
		}
	}
}

function buildOffsetMaps(
	sourceText: string,
	plainTextLength: number,
	segments: SourcePlainSegment[],
): { sourceToPlainOffsets: number[] } {
	const sourceToPlainOffsets = new Array<number>(sourceText.length + 1).fill(0);
	const sorted = [...segments].sort(
		(left, right) =>
			left.sourceStart - right.sourceStart ||
			left.plainStart - right.plainStart,
	);

	let sourceCursor = 0;
	let plainCursor = 0;
	for (const segment of sorted) {
		const sourceStart = Math.max(
			0,
			Math.min(sourceText.length, segment.sourceStart),
		);
		const sourceEnd = Math.max(
			sourceStart,
			Math.min(sourceText.length, segment.sourceEnd),
		);
		for (let index = sourceCursor; index <= sourceStart; index += 1) {
			sourceToPlainOffsets[index] = plainCursor;
		}
		const plainSegmentLength = Math.max(
			0,
			segment.plainEnd - segment.plainStart,
		);
		for (let index = sourceStart; index <= sourceEnd; index += 1) {
			const relative = index - sourceStart;
			sourceToPlainOffsets[index] =
				segment.plainStart + Math.min(relative, plainSegmentLength);
		}
		sourceCursor = Math.max(sourceCursor, sourceEnd);
		plainCursor = Math.max(plainCursor, segment.plainEnd);
	}

	for (let index = sourceCursor; index <= sourceText.length; index += 1) {
		sourceToPlainOffsets[index] = plainCursor;
	}
	if (sourceToPlainOffsets[sourceText.length] !== plainTextLength) {
		sourceToPlainOffsets[sourceText.length] = plainTextLength;
	}

	return { sourceToPlainOffsets };
}

export function parseMarkdownToPlainDocument(
	sourceText: string,
): ParsedMarkdownDocument {
	const tree = parseProcessor.parse(sourceText) as Root;
	const state = {
		plainParts: [] as string[],
		plainLength: 0,
		spans: [] as FormattingSpan[],
		segments: [] as SourcePlainSegment[],
		blockCount: 0,
	};
	walkBlocks(tree.children ?? [], 0, state);
	const plainText = state.plainParts.join("");
	const { sourceToPlainOffsets } = buildOffsetMaps(
		sourceText,
		plainText.length,
		state.segments,
	);
	return {
		plainText,
		spans: state.spans,
		sourceToPlainOffsets,
	};
}

function hierarchyTypeForRank(rank: number): HierarchyLevelType {
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

function scopeRangeFromNode(
	paragraphs: Array<ParsedParagraph & { plainStart: number; plainEnd: number }>,
	node: HierarchyNode,
): ScopeRange | null {
	const startParagraph = paragraphs[node.startParagraph];
	if (!startParagraph) return null;
	const inclusiveEndParagraphIndex = Math.max(
		node.startParagraph,
		node.endParagraph - 1,
	);
	const endParagraph = paragraphs[inclusiveEndParagraphIndex] ?? startParagraph;
	const nextParagraph = paragraphs[node.endParagraph];
	const start = startParagraph.plainStart;
	const end = Math.max(
		start,
		typeof nextParagraph?.plainStart === "number"
			? nextParagraph.plainStart
			: endParagraph.plainEnd,
	);
	return {
		start,
		end,
		indent: node.indent,
	};
}

function getLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

interface BuildNodesArgs {
	paragraphs: Array<ParsedParagraph & { plainStart: number; plainEnd: number }>;
	nodes: HierarchyNode[];
	parentPath: HierarchyLevel[];
	nodesById: Map<string, StructuralNode>;
}

function buildNodes(args: BuildNodesArgs): string[] {
	const builtNodeIds: string[] = [];
	const siblingCounts = new Map<string, number>();

	for (const node of args.nodes) {
		const kind = hierarchyTypeForRank(node.rank);
		const labelLower = node.marker.toLowerCase();
		const siblingKey = `${kind}:${labelLower}`;
		const siblingCount = (siblingCounts.get(siblingKey) ?? 0) + 1;
		siblingCounts.set(siblingKey, siblingCount);

		const idPath = [...args.parentPath, { type: kind, val: node.marker }]
			.map((segment) => `${segment.type}:${segment.val.toLowerCase()}`)
			.join("/");
		const nodeId = `${idPath}#${siblingCount}`;

		const range = scopeRangeFromNode(args.paragraphs, node);
		if (!range) continue;

		const path = buildPath(args.parentPath, kind, node.marker);
		const structuralNode: StructuralNode = {
			id: nodeId,
			kind,
			label: node.marker,
			path,
			start: range.start,
			end: range.end,
			indent: range.indent ?? 0,
			childIds: [],
		};
		args.nodesById.set(nodeId, structuralNode);
		builtNodeIds.push(nodeId);

		const childIds = buildNodes({
			paragraphs: args.paragraphs,
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

export function buildCanonicalDocument(
	sourceText: string,
	parsedPlain?: ParsedMarkdownDocument,
): CanonicalDocument {
	const plain = parsedPlain ?? parseMarkdownToPlainDocument(sourceText);
	const lineStarts = getLineStarts(sourceText);

	const paragraphs: Array<
		ParsedParagraph & { plainStart: number; plainEnd: number }
	> = [];
	let paragraphIndex = 0;

	let sourceOffsetCursor = 0;
	let lineCursor = 0;

	for (const span of plain.spans) {
		if (span.type === "paragraph") {
			const text = plain.plainText.slice(span.start, span.end);
			const lines = text.split("\n");
			let currentPlainOffset = span.start;

			for (let i = 0; i < lines.length; i++) {
				const lineText = lines[i] ?? "";
				const labels = extractLeadingLabels(lineText);

				// Find source offset for this line's start in plainText
				while (
					sourceOffsetCursor < plain.sourceToPlainOffsets.length &&
					(plain.sourceToPlainOffsets[sourceOffsetCursor] ?? 0) <
						currentPlainOffset
				) {
					sourceOffsetCursor++;
				}
				const safeSourceOffset = Math.min(
					sourceText.length,
					sourceOffsetCursor,
				);

				// Find source line index
				while (
					lineCursor < lineStarts.length &&
					(lineStarts[lineCursor] ?? 0) <= safeSourceOffset
				) {
					lineCursor++;
				}
				const currentLine = Math.max(0, lineCursor - 1);

				if (labels.length > 0 || i === 0) {
					paragraphs.push({
						index: paragraphIndex++,
						startLine: currentLine,
						endLine: currentLine + 1,
						text: lineText,
						indent: (span.metadata?.quoteDepth as number) ?? 0,
						leadingLabels: labels,
						plainStart: currentPlainOffset,
						plainEnd: currentPlainOffset + lineText.length,
					});
				} else {
					const prev = paragraphs[paragraphs.length - 1];
					if (prev) {
						prev.text += `\n${lineText}`;
						prev.endLine = currentLine + 1;
						prev.plainEnd = currentPlainOffset + lineText.length;
					}
				}

				const hasFollowingLine = i < lines.length - 1;
				currentPlainOffset += lineText.length + (hasFollowingLine ? 1 : 0);
			}
		}
	}
	const parsedHierarchy = buildHierarchyFromParagraphs(paragraphs);

	const nodesById = new Map<string, StructuralNode>();
	const rootNodeIds = buildNodes({
		paragraphs,
		nodes: parsedHierarchy.levels,
		parentPath: [],
		nodesById,
	});
	const documentParagraphs: DocumentParagraph[] = paragraphs.map(
		(paragraph) => ({
			index: paragraph.index,
			start: paragraph.plainStart,
			end: paragraph.plainEnd,
			startLine: paragraph.startLine,
			endLine: paragraph.endLine,
			indent: paragraph.indent,
			leadingLabels: paragraph.leadingLabels,
		}),
	);

	return {
		plainText: plain.plainText,
		spans: plain.spans,
		sourceToPlainOffsets: plain.sourceToPlainOffsets,
		rootRange: {
			start: 0,
			end: plain.plainText.length,
			indent: null,
		},
		nodesById,
		rootNodeIds,
		paragraphs: documentParagraphs,
	};
}

export function getScopeRangeFromNodeId(
	model: CanonicalDocument,
	nodeId: string | null,
): ScopeRange | null {
	if (nodeId === null) return model.rootRange;
	const node = model.nodesById.get(nodeId);
	if (!node) return null;
	return {
		start: node.start,
		end: node.end,
		indent: node.indent,
	};
}
