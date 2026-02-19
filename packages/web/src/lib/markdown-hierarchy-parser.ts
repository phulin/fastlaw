export interface HierarchyParagraph {
	index: number;
	startLine: number;
	endLine: number;
	text: string;
}

interface ParsedParagraph extends HierarchyParagraph {
	quoteDepth: number;
	leadingLabels: string[];
}

interface MarkerOccurrence {
	label: string;
	level: number;
	paragraphIndex: number;
}

export interface HierarchyNode {
	marker: string;
	level: number;
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

function extractLeadingLabels(line: string): string[] {
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

function parseParagraphs(markdown: string): ParsedParagraph[] {
	const lines = markdown.split("\n");
	const paragraphs: ParsedParagraph[] = [];
	let currentStart = -1;
	let previousLine = "";

	const isStructuralStartLine = (line: string): boolean => {
		if (line.trim().length === 0) return false;
		return extractLeadingLabels(line).length > 0;
	};

	for (let lineIndex = 0; lineIndex <= lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		const isBreak = line.trim().length === 0 || lineIndex === lines.length;
		const isStructuralSplit =
			currentStart >= 0 &&
			lineIndex < lines.length &&
			previousLine.trim().length > 0 &&
			isStructuralStartLine(line);
		if (!isBreak) {
			if (isStructuralSplit) {
				const startLine = currentStart;
				const endLine = lineIndex;
				const paragraphLines = lines.slice(startLine, endLine);
				const firstLine = paragraphLines[0] ?? "";
				paragraphs.push({
					index: paragraphs.length,
					startLine,
					endLine,
					text: paragraphLines.join("\n"),
					quoteDepth: countLeadingQuoteDepth(firstLine),
					leadingLabels: extractLeadingLabels(firstLine),
				});
				currentStart = lineIndex;
				previousLine = line;
				continue;
			}
			if (currentStart < 0) currentStart = lineIndex;
			previousLine = line;
			continue;
		}
		if (currentStart < 0) continue;

		const startLine = currentStart;
		const endLine = lineIndex;
		const paragraphLines = lines.slice(startLine, endLine);
		const firstLine = paragraphLines[0] ?? "";
		paragraphs.push({
			index: paragraphs.length,
			startLine,
			endLine,
			text: paragraphLines.join("\n"),
			quoteDepth: countLeadingQuoteDepth(firstLine),
			leadingLabels: extractLeadingLabels(firstLine),
		});
		currentStart = -1;
		previousLine = "";
	}

	return paragraphs;
}

function collectMarkers(paragraphs: ParsedParagraph[]): MarkerOccurrence[] {
	const occurrences: MarkerOccurrence[] = [];
	for (const paragraph of paragraphs) {
		for (
			let markerIndex = 0;
			markerIndex < paragraph.leadingLabels.length;
			markerIndex++
		) {
			const label = paragraph.leadingLabels[markerIndex];
			if (!label) continue;
			occurrences.push({
				label,
				level: paragraph.quoteDepth + markerIndex,
				paragraphIndex: paragraph.index,
			});
		}
	}
	return occurrences;
}

interface MutableNode {
	marker: string;
	level: number;
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

export function parseMarkdownHierarchy(markdown: string): MarkdownHierarchy {
	const parsedParagraphs = parseParagraphs(markdown);
	const paragraphs: HierarchyParagraph[] = parsedParagraphs.map(
		(paragraph) => ({
			index: paragraph.index,
			startLine: paragraph.startLine,
			endLine: paragraph.endLine,
			text: paragraph.text,
		}),
	);
	const markers = collectMarkers(parsedParagraphs);
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
			if (paragraph.quoteDepth < marker.level) {
				endParagraph = paragraphIndex;
				break;
			}
			if (paragraph.leadingLabels.length === 0) continue;
			const firstMarkerLevel = paragraph.quoteDepth;
			if (firstMarkerLevel <= marker.level) {
				endParagraph = paragraphIndex;
				break;
			}
		}
		return {
			marker: marker.label,
			level: marker.level,
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
			if (top && top.level >= node.level) {
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
