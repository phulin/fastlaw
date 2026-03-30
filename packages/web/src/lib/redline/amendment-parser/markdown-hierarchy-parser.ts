import { buildInferredMarkerLevels } from "../../marker-level-inference";

export interface HierarchyParagraph {
	index: number;
	startLine: number;
	endLine: number;
	text: string;
}

export interface ParsedParagraph extends HierarchyParagraph {
	indent: number;
	leadingLabels: string[];
}

interface MarkerOccurrence {
	label: string;
	indent: number;
	rank: number;
	paragraphIndex: number;
}

export interface HierarchyNode {
	marker: string;
	indent: number;
	rank: number;
	startParagraph: number;
	endParagraph: number;
	heading: HierarchyParagraph[];
	sublevels: HierarchyNode[];
	footing: HierarchyParagraph[];
}

export interface MarkdownHierarchy {
	paragraphs: HierarchyParagraph[];
	levels: HierarchyNode[];
}

function countLeadingQuoteDepth(line: string): number {
	const match = line.match(/^(>\s*)+/);
	if (!match) return 0;
	return (match[0].match(/>/g) ?? []).length;
}

export function extractLeadingLabels(line: string): string[] {
	const depth = countLeadingQuoteDepth(line);
	const withoutQuotes = depth > 0 ? line.replace(/^(>\s*)+/, "") : line;
	let rest = withoutQuotes.trimStart();
	const labels: string[] = [];

	while (rest.length > 0) {
		const boldChain = rest.match(/^\*\*((?:\([^)]+\))+?)\*\*/);
		if (boldChain) {
			const markers = boldChain[1]?.match(/\(([^)]+)\)/g) ?? [];
			for (const marker of markers) {
				labels.push(marker.slice(1, -1));
			}
			rest = rest.slice(boldChain[0].length).trimStart();
			continue;
		}

		const plainMarker = rest.match(/^\(([^)]+)\)/);
		if (plainMarker) {
			labels.push(plainMarker[1] ?? "");
			rest = rest.slice(plainMarker[0].length).trimStart();
			continue;
		}

		break;
	}

	return labels;
}

function collectMarkers(paragraphs: ParsedParagraph[]): {
	occurrences: MarkerOccurrence[];
	firstIndentByParagraph: Map<number, number>;
	firstRankByParagraph: Map<number, number>;
} {
	const occurrences: MarkerOccurrence[] = [];
	const firstIndentByParagraph = new Map<number, number>();
	const firstRankByParagraph = new Map<number, number>();

	for (const paragraph of paragraphs) {
		const inferredLevels = buildInferredMarkerLevels([
			{
				markers: paragraph.leadingLabels,
				indentationHint: paragraph.indent,
			},
		])[0];
		for (
			let markerIndex = 0;
			markerIndex < paragraph.leadingLabels.length;
			markerIndex++
		) {
			const label = paragraph.leadingLabels[markerIndex];
			if (!label) continue;
			const indent = paragraph.indent + markerIndex;
			const rank = inferredLevels?.[markerIndex]?.rank ?? 7;
			occurrences.push({
				label,
				indent,
				rank,
				paragraphIndex: paragraph.index,
			});
			if (!firstIndentByParagraph.has(paragraph.index)) {
				firstIndentByParagraph.set(paragraph.index, indent);
				firstRankByParagraph.set(paragraph.index, rank);
			}
		}
	}
	return { occurrences, firstIndentByParagraph, firstRankByParagraph };
}

interface MutableNode {
	marker: string;
	indent: number;
	rank: number;
	startParagraph: number;
	endParagraph: number;
	heading: HierarchyParagraph[];
	sublevels: MutableNode[];
	footing: HierarchyParagraph[];
}

function nodeToOutput(node: MutableNode): HierarchyNode {
	return {
		...node,
		sublevels: node.sublevels.map(nodeToOutput),
	};
}

function assignSegments(
	node: MutableNode,
	paragraphs: HierarchyParagraph[],
): void {
	for (const child of node.sublevels) {
		assignSegments(child, paragraphs);
	}
	if (node.sublevels.length === 0) {
		node.heading = paragraphs.slice(node.startParagraph, node.endParagraph);
		node.footing = [];
		return;
	}
	const firstChild = node.sublevels[0];
	const lastChild = node.sublevels[node.sublevels.length - 1];
	const headingEnd = firstChild?.startParagraph ?? node.endParagraph;
	const footingStart = lastChild?.endParagraph ?? node.endParagraph;
	node.heading = paragraphs.slice(node.startParagraph, headingEnd);
	node.footing = paragraphs.slice(footingStart, node.endParagraph);
}

export function buildHierarchyFromParagraphs(
	parsedParagraphs: ParsedParagraph[],
): MarkdownHierarchy {
	const paragraphs: HierarchyParagraph[] = parsedParagraphs.map(
		(paragraph) => ({
			index: paragraph.index,
			startLine: paragraph.startLine,
			endLine: paragraph.endLine,
			text: paragraph.text,
		}),
	);
	const {
		occurrences: markers,
		firstIndentByParagraph,
		firstRankByParagraph,
	} = collectMarkers(parsedParagraphs);
	if (markers.length === 0) {
		return {
			paragraphs,
			levels: [],
		};
	}

	const nodes: MutableNode[] = markers.map((marker) => {
		let endParagraph = paragraphs.length;
		for (
			let paragraphIndex = marker.paragraphIndex + 1;
			paragraphIndex < parsedParagraphs.length;
			paragraphIndex++
		) {
			const paragraph = parsedParagraphs[paragraphIndex];
			if (!paragraph) continue;
			if (paragraph.indent < marker.indent) {
				endParagraph = paragraphIndex;
				break;
			}
			const firstMarkerIndent = firstIndentByParagraph.get(paragraphIndex);
			const firstMarkerRank = firstRankByParagraph.get(paragraphIndex);
			if (
				firstMarkerIndent !== undefined &&
				(firstMarkerIndent < marker.indent ||
					(firstMarkerIndent === marker.indent &&
						(firstMarkerRank ?? 7) <= marker.rank))
			) {
				endParagraph = paragraphIndex;
				break;
			}
		}
		return {
			marker: marker.label,
			indent: marker.indent,
			rank: marker.rank,
			startParagraph: marker.paragraphIndex,
			endParagraph,
			heading: [],
			sublevels: [],
			footing: [],
		};
	});

	const rootNodes: MutableNode[] = [];
	const stack: MutableNode[] = [];
	for (const node of nodes) {
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (
				top &&
				(top.indent > node.indent ||
					(top.indent === node.indent && top.rank >= node.rank))
			) {
				stack.pop();
				continue;
			}
			break;
		}
		const parent = stack[stack.length - 1];
		if (parent) {
			parent.sublevels.push(node);
		} else {
			rootNodes.push(node);
		}
		stack.push(node);
	}

	for (const root of rootNodes) {
		assignSegments(root, paragraphs);
	}

	return {
		paragraphs,
		levels: rootNodes.map(nodeToOutput),
	};
}

export function findHierarchyNodeByMarkerPath(
	levels: HierarchyNode[],
	path: string[],
): HierarchyNode | null {
	let currentLevels = levels;
	let current: HierarchyNode | null = null;
	for (const marker of path) {
		const lowerMarker = marker.toLowerCase();
		const next =
			currentLevels.find(
				(level) => level.marker.toLowerCase() === lowerMarker,
			) ?? null;
		if (!next) return null;
		current = next;
		currentLevels = next.sublevels;
	}
	return current;
}

export function parseMarkdownHierarchy(markdown: string): MarkdownHierarchy {
	const lines = markdown.split("\n");
	const paragraphs: ParsedParagraph[] = [];
	let currentParagraph: ParsedParagraph | null = null;
	let paragraphIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		const quoteDepth = countLeadingQuoteDepth(line);
		const labels = extractLeadingLabels(line);

		if (trimmed === "") {
			currentParagraph = null;
			continue;
		}

		if (labels.length > 0 || currentParagraph === null) {
			currentParagraph = {
				index: paragraphIndex++,
				startLine: i,
				endLine: i + 1,
				text: line,
				indent: quoteDepth,
				leadingLabels: labels,
			};
			paragraphs.push(currentParagraph);
		} else {
			currentParagraph.text += `\n${line}`;
			currentParagraph.endLine = i + 1;
		}
	}

	return buildHierarchyFromParagraphs(paragraphs);
}
