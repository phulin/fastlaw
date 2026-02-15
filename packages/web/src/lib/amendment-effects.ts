import type {
	AmendatoryInstruction,
	HierarchyLevel,
	InstructionNode,
} from "./amendatory-instructions";
import type { NodeContent } from "./types";

export type AmendmentSegmentKind = "unchanged" | "deleted" | "inserted";

export interface AmendmentEffectSegment {
	kind: AmendmentSegmentKind;
	text: string;
}

export interface AmendmentEffect {
	status: "ok" | "unsupported";
	sectionPath: string;
	segments: AmendmentEffectSegment[];
	deleted: string[];
	inserted: string[];
}

export interface SectionBodiesRequest {
	paths: string[];
}

export interface SectionBodiesResponse {
	results: Array<
		| {
				path: string;
				status: "ok";
				content: NodeContent;
		  }
		| {
				path: string;
				status: "not_found" | "error";
				error?: string;
		  }
	>;
}

const USC_CITATION_PARSE_RE = /^(\d+)\s+U\.S\.C\.\s+([0-9A-Za-z-]+)/i;

interface StringPatch {
	start: number;
	end: number;
	inserted: string;
	deleted: string;
}

interface TextRange {
	start: number;
	end: number;
}

interface StructureMarker {
	index: number;
	label: string;
	rank: number;
}

type ValuedHierarchyLevel = Exclude<HierarchyLevel, { type: "none" }>;
type TargetHierarchyLevel = Exclude<ValuedHierarchyLevel, { type: "section" }>;

const STRUCTURE_MARKER_RE =
	/(?:^|\n)\s*(?:>\s*)?(?:\*\*)?\(([A-Za-z0-9]+)\)(?:\*\*)?/g;

function getLevelRank(type: string): number {
	switch (type) {
		case "subsection":
			return 1;
		case "paragraph":
			return 2;
		case "subparagraph":
			return 3;
		case "clause":
			return 4;
		case "subclause":
			return 5;
		case "item":
			return 6;
		case "subitem":
			return 7;
		default:
			return 100;
	}
}

function isLowerRoman(value: string): boolean {
	return /^[ivxlcdm]+$/.test(value);
}

function isUpperRoman(value: string): boolean {
	return /^[IVXLCDM]+$/.test(value);
}

function markerMatchesLevel(
	marker: StructureMarker,
	level: ValuedHierarchyLevel,
): boolean {
	if (marker.label !== level.val) return false;
	switch (level.type) {
		case "subsection":
			return /^[a-z]+$/.test(marker.label) && !isLowerRoman(marker.label);
		case "paragraph":
			return /^\d+$/.test(marker.label);
		case "subparagraph":
			return /^[A-Z]+$/.test(marker.label) && !isUpperRoman(marker.label);
		case "clause":
			return isLowerRoman(marker.label);
		case "subclause":
			return isUpperRoman(marker.label);
		case "item":
		case "subitem":
			return true;
		default:
			return false;
	}
}

function isTargetHierarchyLevel(
	level: HierarchyLevel,
): level is TargetHierarchyLevel {
	return level.type !== "none" && level.type !== "section";
}

function collectStructureMarkers(text: string): StructureMarker[] {
	const markers: StructureMarker[] = [];
	for (const match of text.matchAll(STRUCTURE_MARKER_RE)) {
		const label = match[1];
		if (!label) continue;
		let inferredType: string;
		if (/^\d+$/.test(label)) inferredType = "paragraph";
		else if (isLowerRoman(label)) inferredType = "clause";
		else if (isUpperRoman(label)) inferredType = "subclause";
		else if (/^[a-z]+$/.test(label)) inferredType = "subsection";
		else if (/^[A-Z]+$/.test(label)) inferredType = "subparagraph";
		else inferredType = "item";

		markers.push({
			index: match.index ?? 0,
			label,
			rank: getLevelRank(inferredType),
		});
	}
	return markers;
}

function getTargetRange(
	text: string,
	target: HierarchyLevel[] | undefined,
): TextRange | null {
	if (!target || target.length === 0) return null;
	const path = target
		.filter(isTargetHierarchyLevel)
		.filter((level) => level.val.length > 0);
	if (path.length === 0) return null;

	const markers = collectStructureMarkers(text);
	if (markers.length === 0) return null;

	let scopeStart = 0;
	let scopeEnd = text.length;

	for (const level of path) {
		const rank = getLevelRank(level.type);
		const marker = markers.find(
			(candidate) =>
				candidate.index >= scopeStart &&
				candidate.index < scopeEnd &&
				markerMatchesLevel(candidate, level),
		);
		if (!marker) return null;
		scopeStart = marker.index;

		const siblingOrAncestor = markers.find(
			(candidate) =>
				candidate.index > marker.index &&
				candidate.index < scopeEnd &&
				candidate.rank <= rank,
		);
		scopeEnd = siblingOrAncestor ? siblingOrAncestor.index : scopeEnd;
	}

	return { start: scopeStart, end: scopeEnd };
}

function applyPatch(text: string, patch: StringPatch): string {
	return text.slice(0, patch.start) + patch.inserted + text.slice(patch.end);
}

function firstIndexOfOrNull(
	text: string,
	needle: string,
	searchRange?: TextRange | null,
): number | null {
	const haystack = searchRange
		? text.slice(searchRange.start, searchRange.end)
		: text;
	const index = haystack.indexOf(needle);
	return index === -1 ? null : index;
}

function patchFromReplace(
	text: string,
	strikingContent: string | undefined,
	insertingContent: string | undefined,
	searchRange?: TextRange | null,
): StringPatch | null {
	if (!strikingContent || !insertingContent) return null;
	const localStart = firstIndexOfOrNull(text, strikingContent, searchRange);
	if (localStart === null) return null;
	const offset = searchRange ? searchRange.start : 0;
	const start = offset + localStart;
	return {
		start,
		end: start + strikingContent.length,
		deleted: strikingContent,
		inserted: insertingContent,
	};
}

function patchFromDelete(
	text: string,
	strikingContent: string | undefined,
	searchRange?: TextRange | null,
): StringPatch | null {
	if (!strikingContent) return null;
	const localStart = firstIndexOfOrNull(text, strikingContent, searchRange);
	if (localStart === null) return null;
	const offset = searchRange ? searchRange.start : 0;
	const start = offset + localStart;
	return {
		start,
		end: start + strikingContent.length,
		deleted: strikingContent,
		inserted: "",
	};
}

function extractAnchor(
	nodeText: string,
	direction: "before" | "after",
): string | null {
	const pattern = new RegExp(`${direction}\\s+["“'‘]([^"”'’]+)["”'’]`, "i");
	const match = nodeText.match(pattern);
	return match?.[1] ?? null;
}

function patchFromInsertRelative(
	text: string,
	nodeText: string,
	content: string | undefined,
	direction: "before" | "after",
	searchRange?: TextRange | null,
): StringPatch | null {
	if (!content) return null;
	const anchor = extractAnchor(nodeText, direction);
	if (!anchor) return null;
	const localAnchorStart = firstIndexOfOrNull(text, anchor, searchRange);
	if (localAnchorStart === null) return null;
	const offset = searchRange ? searchRange.start : 0;
	const anchorStart = offset + localAnchorStart;
	const start =
		direction === "before" ? anchorStart : anchorStart + anchor.length;
	return {
		start,
		end: start,
		deleted: "",
		inserted: content,
	};
}

function collectQuotedChildren(node: InstructionNode): string[] {
	const chunks: string[] = [];
	for (const child of node.children) {
		if (
			child.operation.type === "unknown" &&
			typeof child.operation.content === "string"
		) {
			chunks.push(child.operation.content);
		}
		chunks.push(...collectQuotedChildren(child));
	}
	return chunks;
}

function patchFromAddAtEnd(
	text: string,
	node: InstructionNode,
	searchRange?: TextRange | null,
): StringPatch | null {
	const content =
		node.operation.content ?? collectQuotedChildren(node).join("\n").trim();
	if (!content) return null;
	const insertAt = searchRange ? searchRange.end : text.length;
	const beforeInsert = text.slice(0, insertAt);
	const needsLineBreak =
		beforeInsert.length > 0 && !beforeInsert.endsWith("\n");
	const inserted = `${needsLineBreak ? "\n" : ""}${content}`;
	return {
		start: insertAt,
		end: insertAt,
		deleted: "",
		inserted,
	};
}

function collectOperations(root: InstructionNode[]): InstructionNode[] {
	const nodes: InstructionNode[] = [];
	const walk = (list: InstructionNode[]) => {
		for (const node of list) {
			nodes.push(node);
			if (node.children.length > 0) {
				walk(node.children);
			}
		}
	};
	walk(root);
	return nodes;
}

export function getSectionBodyText(
	content: NodeContent | null | undefined,
): string {
	if (!content) return "";
	return content.blocks
		.filter((block) => block.type === "body")
		.map((block) => block.content ?? "")
		.join("\n\n")
		.trim();
}

export function getSectionPathFromUscCitation(
	citation: string | null,
): string | null {
	if (!citation) return null;
	const match = citation.match(USC_CITATION_PARSE_RE);
	if (!match) return null;
	const title = match[1];
	const section = match[2];
	return `/statutes/usc/section/${title}/${section}`;
}

export function computeAmendmentEffect(
	instruction: AmendatoryInstruction,
	sectionPath: string,
	sectionBody: string,
): AmendmentEffect {
	const operations = collectOperations(instruction.tree);
	const patches: StringPatch[] = [];
	let workingText = sectionBody;

	for (const node of operations) {
		let patch: StringPatch | null = null;
		const searchRange = getTargetRange(workingText, node.operation.target);
		switch (node.operation.type) {
			case "replace":
				patch = patchFromReplace(
					workingText,
					node.operation.strikingContent,
					node.operation.content,
					searchRange,
				);
				break;
			case "delete":
				patch = patchFromDelete(
					workingText,
					node.operation.strikingContent,
					searchRange,
				);
				break;
			case "insert": {
				if (!node.operation.content) {
					break;
				}
				const insertAt = searchRange ? searchRange.end : workingText.length;
				const beforeInsert = workingText.slice(0, insertAt);
				patch = {
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: `${beforeInsert.endsWith("\n") ? "" : "\n"}${node.operation.content}`,
				};
				break;
			}
			case "insert_before":
				patch = patchFromInsertRelative(
					workingText,
					node.text,
					node.operation.content,
					"before",
					searchRange,
				);
				break;
			case "insert_after":
				patch = patchFromInsertRelative(
					workingText,
					node.text,
					node.operation.content,
					"after",
					searchRange,
				);
				break;
			case "add_at_end":
				patch = patchFromAddAtEnd(workingText, node, searchRange);
				break;
			default:
				break;
		}

		if (!patch) continue;
		patches.push(patch);
		workingText = applyPatch(workingText, patch);
	}

	if (patches.length === 0) {
		return {
			status: "unsupported",
			sectionPath,
			segments: [{ kind: "unchanged", text: sectionBody }],
			deleted: [],
			inserted: [],
		};
	}

	return {
		status: "ok",
		sectionPath,
		segments: [{ kind: "unchanged", text: workingText }],
		deleted: patches
			.map((patch) => patch.deleted)
			.filter((text) => text.length > 0),
		inserted: patches
			.map((patch) => patch.inserted)
			.filter((text) => text.length > 0),
	};
}
