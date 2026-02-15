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
	changes: Array<{ deleted: string; inserted: string }>;
	deleted: string[];
	inserted: string[];
	debug: AmendmentEffectDebug;
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

export interface OperationMatchAttempt {
	operationType: string;
	nodeText: string;
	targetPath: string | null;
	hasExplicitTargetPath: boolean;
	scopedRange: {
		start: number;
		end: number;
		length: number;
		preview: string;
	} | null;
	searchText: string | null;
	searchTextKind: "striking" | "anchor_before" | "anchor_after" | "none";
	searchIndex: number | null;
	patchApplied: boolean;
	outcome: "applied" | "no_patch" | "scope_unresolved";
}

export interface AmendmentEffectDebug {
	sectionTextLength: number;
	operationCount: number;
	operationAttempts: OperationMatchAttempt[];
	failureReason: string | null;
}

interface StructureMarker {
	index: number;
	label: string;
	rank: number;
}

type ValuedHierarchyLevel = Exclude<HierarchyLevel, { type: "none" }>;
type TargetHierarchyLevel = Exclude<ValuedHierarchyLevel, { type: "section" }>;

const STRUCTURE_MARKER_RE =
	/(?:^|\n)\s*((?:>\s*)*)(?:\*\*)?((?:\([A-Za-z0-9]+\))+)(?:\*\*)?/g;
const STRUCTURE_LABEL_RE = /\(([A-Za-z0-9]+)\)/g;

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

function mergeHierarchyTargets(
	baseTarget: HierarchyLevel[] | undefined,
	nodeTarget: HierarchyLevel[] | undefined,
): HierarchyLevel[] | undefined {
	if (!baseTarget && !nodeTarget) return undefined;
	if (!baseTarget || baseTarget.length === 0) return nodeTarget;
	if (!nodeTarget || nodeTarget.length === 0) return baseTarget;

	const merged = [...baseTarget];
	for (const level of nodeTarget) {
		if (level.type === "none") continue;
		const levelRank = getLevelRank(level.type);
		for (let i = merged.length - 1; i >= 0; i--) {
			const existing = merged[i];
			if (existing.type === "none") continue;
			if (getLevelRank(existing.type) >= levelRank) {
				merged.splice(i, 1);
			}
		}
		merged.push(level);
	}
	return merged;
}

function isLowerRoman(value: string): boolean {
	return /^[ivxlc]+$/.test(value);
}

function isUpperRoman(value: string): boolean {
	return /^[IVXLCDM]+$/.test(value);
}

function markerMatchesLevel(
	marker: StructureMarker,
	level: ValuedHierarchyLevel,
): boolean {
	return marker.label === level.val && marker.rank === getLevelRank(level.type);
}

function isTargetHierarchyLevel(
	level: HierarchyLevel,
): level is TargetHierarchyLevel {
	return level.type !== "none" && level.type !== "section";
}

function collectStructureMarkers(text: string): StructureMarker[] {
	const markers: StructureMarker[] = [];
	for (const match of text.matchAll(STRUCTURE_MARKER_RE)) {
		const quotePrefix = match[1];
		const chain = match[2];
		if (!chain) continue;
		const indentationLevel = (quotePrefix?.match(/>/g) ?? []).length;
		for (const labelMatch of chain.matchAll(STRUCTURE_LABEL_RE)) {
			const label = labelMatch[1];
			if (!label) continue;
			let inferredType: string;
			if (/^\d+$/.test(label)) inferredType = "paragraph";
			else if (isLowerRoman(label) && indentationLevel > 1)
				inferredType = "clause";
			else if (isUpperRoman(label) && indentationLevel > 3)
				inferredType = "subclause";
			else if (/^[a-z]$/.test(label)) inferredType = "subsection";
			else if (/^[A-Z]$/.test(label)) inferredType = "subparagraph";
			else if (/^[a-z]+$/.test(label)) inferredType = "item";
			else if (/^[A-Z]+$/.test(label)) inferredType = "item";
			else inferredType = "item";

			markers.push({
				index: (match.index ?? 0) + (labelMatch.index ?? 0),
				label,
				rank: getLevelRank(inferredType),
			});
		}
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

function hasExplicitTargetPath(target: HierarchyLevel[] | undefined): boolean {
	if (!target || target.length === 0) return false;
	return target
		.filter(isTargetHierarchyLevel)
		.some((level) => level.val.length > 0);
}

function formatTargetPath(target: HierarchyLevel[] | undefined): string | null {
	if (!target || target.length === 0) return null;
	const parts = target
		.filter(isTargetHierarchyLevel)
		.filter((level) => level.val.length > 0)
		.map((level) => `${level.type}:${level.val}`);
	return parts.length > 0 ? parts.join(" > ") : null;
}

function previewRange(text: string, range: TextRange | null): string {
	if (!range) return "";
	const raw = text.slice(range.start, range.end).trim();
	if (raw.length <= 600) return raw;
	return `${raw.slice(0, 600)}...`;
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

interface SectionReference {
	number: string;
	suffix: string;
}

interface FuzzyReplaceMatch {
	localStart: number;
	matchedText: string;
}

function parseBareSectionReference(input: string): SectionReference | null {
	const match = input.match(/^\s*section\s+(\d+)((?:\([A-Za-z0-9]+\))+)\s*$/i);
	if (!match) return null;
	return { number: match[1] ?? "", suffix: match[2] ?? "" };
}

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMarkdownForMatching(text: string): string {
	return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "");
}

function buildFlexibleSectionReferencePattern(_: string): string {
	const refCore =
		"section\\s+\\d+[A-Za-z0-9-]*(?:\\([A-Za-z0-9]+\\))*" +
		"(?:\\s+of\\s+(?:this\\s+title|title\\s+\\d+[^,.;\\n\\]]*|the\\s+[^,.;\\n\\]]+|Public\\s+Law\\s+\\d+[–-]\\d+[^,.;\\n\\]]*))?";
	return `(?:\\[${refCore}\\]\\([^\\n)]*\\)|${refCore})`;
}

function buildFuzzyReplaceRegex(searchText: string): RegExp | null {
	const normalized = normalizeMarkdownForMatching(searchText).trim();
	if (!/section\s+\d+/i.test(normalized)) return null;

	const sectionRefRe =
		/section\s+\d+[A-Za-z0-9-]*(?:\([A-Za-z0-9]+\))*(?:\s+of\s+(?:this\s+title|title\s+\d+[^,.;\n]*|the\s+[^,.;\n]+|Public\s+Law\s+\d+[–-]\d+[^,.;\n]*))?/gi;
	const spans = Array.from(normalized.matchAll(sectionRefRe));
	if (spans.length === 0) return null;

	let pattern = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.index === undefined) continue;
		const start = span.index;
		const end = start + span[0].length;
		const before = normalized.slice(cursor, start);
		pattern += escapeForRegex(before).replace(/\s+/g, "\\s+");
		pattern += buildFlexibleSectionReferencePattern(span[0]);
		cursor = end;
	}
	pattern += escapeForRegex(normalized.slice(cursor)).replace(/\s+/g, "\\s+");
	if (pattern.length === 0) return null;
	return new RegExp(pattern, "i");
}

function findFuzzyReplaceMatch(
	text: string,
	strikingContent: string,
	searchRange?: TextRange | null,
): FuzzyReplaceMatch | null {
	const haystack = searchRange
		? text.slice(searchRange.start, searchRange.end)
		: text;
	const pattern = buildFuzzyReplaceRegex(strikingContent);
	if (!pattern) return null;
	const match = pattern.exec(haystack);
	if (!match) return null;
	return {
		localStart: match.index,
		matchedText: match[0] ?? "",
	};
}

function findSectionReferenceAlias(
	text: string,
	reference: SectionReference,
	searchRange?: TextRange | null,
): { localStart: number; matchedText: string; matchedNumber: string } | null {
	const haystack = searchRange
		? text.slice(searchRange.start, searchRange.end)
		: text;
	const pattern = new RegExp(
		`\\bsection\\s+(\\d+)${escapeForRegex(reference.suffix)}`,
		"i",
	);
	const match = pattern.exec(haystack);
	if (!match) return null;
	return {
		localStart: match.index,
		matchedText: match[0] ?? "",
		matchedNumber: match[1] ?? "",
	};
}

function normalizeInsertedText(
	insertedText: string,
	followingChar: string | undefined,
): string {
	if (insertedText.length === 0) return insertedText;
	if (/\s$/.test(insertedText)) return insertedText;
	if (!followingChar) return insertedText;
	if (/\s/.test(followingChar)) return insertedText;
	if (/\p{P}/u.test(followingChar)) return insertedText;
	return `${insertedText} `;
}

function getBlockquoteDepthForLineAt(text: string, index: number): number {
	if (text.length === 0) return 0;
	const boundedIndex = Math.max(0, Math.min(index, text.length - 1));
	let lineStart = text.lastIndexOf("\n", boundedIndex) + 1;
	const getDepthAtLineStart = (start: number): number => {
		const nextBreak = text.indexOf("\n", start);
		const line =
			nextBreak === -1 ? text.slice(start) : text.slice(start, nextBreak);
		const prefixMatch = line.match(/^(>\s*)+/);
		if (!prefixMatch) return 0;
		return (prefixMatch[0].match(/>/g) ?? []).length;
	};

	const currentDepth = getDepthAtLineStart(lineStart);
	if (currentDepth > 0) return currentDepth;

	for (let i = 0; i < 8; i++) {
		if (lineStart === 0) break;
		lineStart = text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
		const depth = getDepthAtLineStart(lineStart);
		if (depth > 0) return depth;
	}

	return 0;
}

function inferMarkerRank(marker: string): number {
	if (/^\d+$/.test(marker)) return getLevelRank("paragraph");
	if (/^[ivxlc]+$/.test(marker)) return getLevelRank("clause");
	if (/^[IVXLCDM]+$/.test(marker)) return getLevelRank("subclause");
	if (/^[a-z]+$/.test(marker)) return getLevelRank("subsection");
	if (/^[A-Z]+$/.test(marker)) return getLevelRank("subparagraph");
	return getLevelRank("item");
}

function quotePrefix(depth: number): string {
	if (depth <= 0) return "";
	return `${Array.from({ length: depth }, () => ">").join(" ")} `;
}

function splitHeadingFromBody(
	rest: string,
): { heading: string; body: string | null } | null {
	const match = rest.match(/^([A-Z0-9][A-Z0-9 '"()\-.,/&]+)\.\u2014\s*(.*)$/);
	if (!match) return null;
	const heading = match[1]?.trim();
	if (!heading) return null;
	const body = (match[2] ?? "").trim();
	return { heading, body: body.length > 0 ? body : null };
}

function formatInsertedMultilineContent(
	text: string,
	insertAt: number,
	content: string,
): string {
	if (!content.includes("\n")) return content;
	const rawLines = content.split("\n");
	const markerLines = rawLines
		.map((line) =>
			line
				.trim()
				.replace(/^[“”"‘’']+/, "")
				.replace(/[“”"‘’']+$/, ""),
		)
		.map((line) => line.match(/^\(([A-Za-z0-9]+)\)\s*(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null);
	if (markerLines.length === 0) return content;

	const minMarkerRank = Math.min(
		...markerLines.map((match) => inferMarkerRank(match[1] ?? "")),
	);
	const baseDepth = getBlockquoteDepthForLineAt(text, insertAt);
	let activeDepth = baseDepth;
	const formattedLines: string[] = [];

	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		const unquoted = trimmed
			.replace(/^[“”"‘’']+/, "")
			.replace(/[“”"‘’']+[.;,]*$/, "");
		if (unquoted.length === 0) {
			formattedLines.push("");
			continue;
		}
		const markerMatch = unquoted.match(/^\(([A-Za-z0-9]+)\)\s*(.*)$/);
		if (!markerMatch) {
			formattedLines.push(`${quotePrefix(activeDepth)}${unquoted}`);
			continue;
		}

		const marker = markerMatch[1] ?? "";
		const rest = markerMatch[2] ?? "";
		const markerDepth = baseDepth + (inferMarkerRank(marker) - minMarkerRank);
		activeDepth = markerDepth;
		const headingSplit = splitHeadingFromBody(rest);
		if (headingSplit) {
			formattedLines.push(
				`${quotePrefix(markerDepth)}**(${marker})** **${headingSplit.heading}**`,
			);
			if (headingSplit.body) {
				formattedLines.push(`${quotePrefix(markerDepth)}${headingSplit.body}`);
			}
			continue;
		}

		formattedLines.push(
			`${quotePrefix(markerDepth)}**(${marker})**${rest ? ` ${rest}` : ""}`,
		);
	}

	return formattedLines.join("\n");
}

function patchFromReplace(
	text: string,
	strikingContent: string | undefined,
	insertingContent: string | undefined,
	searchRange?: TextRange | null,
): StringPatch | null {
	if (!strikingContent || !insertingContent) return null;
	const localStart = firstIndexOfOrNull(text, strikingContent, searchRange);
	if (localStart === null) {
		const strikingSection = parseBareSectionReference(strikingContent);
		const insertingSection = parseBareSectionReference(insertingContent);
		if (strikingSection && insertingSection) {
			const aliasMatch = findSectionReferenceAlias(
				text,
				strikingSection,
				searchRange,
			);
			if (aliasMatch) {
				const offset = searchRange ? searchRange.start : 0;
				const start = offset + aliasMatch.localStart;
				const inserted =
					insertingSection.number === strikingSection.number
						? `section ${aliasMatch.matchedNumber}${insertingSection.suffix}`
						: insertingContent;
				return {
					start,
					end: start + aliasMatch.matchedText.length,
					deleted: aliasMatch.matchedText,
					inserted,
				};
			}
		}
		const fuzzyMatch = findFuzzyReplaceMatch(
			text,
			strikingContent,
			searchRange,
		);
		if (!fuzzyMatch) return null;
		const offset = searchRange ? searchRange.start : 0;
		const start = offset + fuzzyMatch.localStart;
		return {
			start,
			end: start + fuzzyMatch.matchedText.length,
			deleted: fuzzyMatch.matchedText,
			inserted: insertingContent,
		};
	}
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
	const precedingChar = start > 0 ? text[start - 1] : undefined;
	const followingChar = text[start];
	const normalizedContent = normalizeInsertedText(content, followingChar);
	const inserted =
		direction === "after" &&
		normalizedContent.length > 0 &&
		!/^\s/.test(normalizedContent) &&
		precedingChar !== undefined &&
		!/\s/.test(precedingChar)
			? ` ${normalizedContent}`
			: normalizedContent;
	return {
		start,
		end: start,
		deleted: "",
		inserted,
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

function getOperationContent(node: InstructionNode): string | undefined {
	const inlineContent = node.operation.content?.trim();
	if (inlineContent) return inlineContent;
	const quotedContent = collectQuotedChildren(node).join("\n").trim();
	return quotedContent.length > 0 ? quotedContent : undefined;
}

function patchFromScopedInsertion(
	text: string,
	content: string | undefined,
	searchRange: TextRange | null,
): StringPatch | null {
	if (!searchRange || !content) return null;
	const insertAt = searchRange.end;
	const beforeInsert = text.slice(0, insertAt);
	const needsLineBreak =
		beforeInsert.length > 0 && !beforeInsert.endsWith("\n");
	const formattedContent = formatInsertedMultilineContent(
		text,
		insertAt,
		content,
	);
	return {
		start: insertAt,
		end: insertAt,
		deleted: "",
		inserted: `${needsLineBreak ? "\n" : ""}${formattedContent}`,
	};
}

function patchFromScopedReplacement(
	text: string,
	content: string | undefined,
	searchRange: TextRange | null,
): StringPatch | null {
	if (!searchRange || !content) return null;
	const beforeRange = text.slice(0, searchRange.start);
	const replacementPrefix =
		beforeRange.length > 0 && !beforeRange.endsWith("\n") ? "\n" : "";
	const formattedContent = formatInsertedMultilineContent(
		text,
		searchRange.start,
		content,
	);
	return {
		start: searchRange.start,
		end: searchRange.end,
		deleted: text.slice(searchRange.start, searchRange.end),
		inserted: `${replacementPrefix}${formattedContent}`,
	};
}

function isScopedStrikeAndInsertFollowing(nodeText: string): boolean {
	return /\bby striking\b[\s\S]*\binserting the following\b/i.test(nodeText);
}

function patchFromAddAtEnd(
	text: string,
	node: InstructionNode,
	searchRange?: TextRange | null,
): StringPatch | null {
	const content = getOperationContent(node);
	if (!content) return null;
	const insertAt = searchRange ? searchRange.end : text.length;
	const beforeInsert = text.slice(0, insertAt);
	const needsLineBreak =
		beforeInsert.length > 0 && !beforeInsert.endsWith("\n");
	const formattedContent = formatInsertedMultilineContent(
		text,
		insertAt,
		content,
	);
	const inserted = `${needsLineBreak ? "\n" : ""}${formattedContent}`;
	return {
		start: insertAt,
		end: insertAt,
		deleted: "",
		inserted,
	};
}

interface ResolvedInstructionNode {
	node: InstructionNode;
	target: HierarchyLevel[] | undefined;
}

function isActionableOperationType(
	type: InstructionNode["operation"]["type"],
): boolean {
	return (
		type === "replace" ||
		type === "delete" ||
		type === "insert" ||
		type === "insert_before" ||
		type === "insert_after" ||
		type === "add_at_end"
	);
}

function collectOperations(root: InstructionNode[]): ResolvedInstructionNode[] {
	const nodes: ResolvedInstructionNode[] = [];
	const walk = (
		list: InstructionNode[],
		inheritedTarget: HierarchyLevel[] | undefined,
	) => {
		for (const node of list) {
			const resolvedTarget = mergeHierarchyTargets(
				inheritedTarget,
				node.operation.target,
			);
			nodes.push({
				node,
				target: resolvedTarget,
			});
			if (node.children.length > 0) {
				walk(node.children, resolvedTarget);
			}
		}
	};
	walk(root, undefined);
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
	const operations = collectOperations(instruction.tree).filter((entry) =>
		isActionableOperationType(entry.node.operation.type),
	);
	const patches: StringPatch[] = [];
	let workingText = sectionBody;
	const operationAttempts: OperationMatchAttempt[] = [];

	for (const node of operations) {
		let patch: StringPatch | null = null;
		const searchRange = getTargetRange(workingText, node.target);
		const explicitTarget = hasExplicitTargetPath(node.target);
		const attempt: OperationMatchAttempt = {
			operationType: node.node.operation.type,
			nodeText: node.node.text,
			targetPath: formatTargetPath(node.target),
			hasExplicitTargetPath: explicitTarget,
			scopedRange: searchRange
				? {
						start: searchRange.start,
						end: searchRange.end,
						length: searchRange.end - searchRange.start,
						preview: previewRange(workingText, searchRange),
					}
				: null,
			searchText: null,
			searchTextKind: "none",
			searchIndex: null,
			patchApplied: false,
			outcome: "no_patch",
		};

		if (explicitTarget && !searchRange) {
			attempt.outcome = "scope_unresolved";
			operationAttempts.push(attempt);
			return {
				status: "unsupported",
				sectionPath,
				segments: [{ kind: "unchanged", text: sectionBody }],
				changes: [],
				deleted: [],
				inserted: [],
				debug: {
					sectionTextLength: sectionBody.length,
					operationCount: operations.length,
					operationAttempts,
					failureReason: "explicit_target_scope_unresolved",
				},
			};
		}
		switch (node.node.operation.type) {
			case "replace":
				attempt.searchText = node.node.operation.strikingContent ?? null;
				attempt.searchTextKind = "striking";
				attempt.searchIndex =
					attempt.searchText === null
						? null
						: firstIndexOfOrNull(workingText, attempt.searchText, searchRange);
				patch = patchFromReplace(
					workingText,
					node.node.operation.strikingContent,
					node.node.operation.content,
					searchRange,
				);
				if (
					!patch &&
					!node.node.operation.strikingContent &&
					(/\bis (?:further )?amended to read as follows\b/i.test(
						node.node.text,
					) ||
						isScopedStrikeAndInsertFollowing(node.node.text))
				) {
					patch = patchFromScopedReplacement(
						workingText,
						getOperationContent(node.node),
						searchRange,
					);
				}
				attempt.outcome = patch ? "applied" : "no_patch";
				break;
			case "delete":
				attempt.searchText = node.node.operation.strikingContent ?? null;
				attempt.searchTextKind = "striking";
				attempt.searchIndex =
					attempt.searchText === null
						? null
						: firstIndexOfOrNull(workingText, attempt.searchText, searchRange);
				patch = patchFromDelete(
					workingText,
					node.node.operation.strikingContent,
					searchRange,
				);
				attempt.outcome = patch ? "applied" : "no_patch";
				break;
			case "insert": {
				if (!node.node.operation.content) {
					attempt.outcome = "no_patch";
					break;
				}
				const insertAt = searchRange ? searchRange.end : workingText.length;
				const followingChar = workingText[insertAt];
				const beforeInsert = workingText.slice(0, insertAt);
				const formattedContent = formatInsertedMultilineContent(
					workingText,
					insertAt,
					node.node.operation.content,
				);
				patch = {
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: `${beforeInsert.endsWith("\n") ? "" : "\n"}${normalizeInsertedText(formattedContent, followingChar)}`,
				};
				attempt.outcome = "applied";
				break;
			}
			case "insert_before": {
				const content = getOperationContent(node.node);
				const anchor = extractAnchor(node.node.text, "before");
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_before";
				attempt.searchIndex =
					anchor === null
						? null
						: firstIndexOfOrNull(workingText, anchor, searchRange);
				patch = patchFromInsertRelative(
					workingText,
					node.node.text,
					content,
					"before",
					searchRange,
				);
				attempt.outcome = patch ? "applied" : "no_patch";
				break;
			}
			case "insert_after": {
				const content = getOperationContent(node.node);
				const anchor = extractAnchor(node.node.text, "after");
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_after";
				attempt.searchIndex =
					anchor === null
						? null
						: firstIndexOfOrNull(workingText, anchor, searchRange);
				patch = patchFromInsertRelative(
					workingText,
					node.node.text,
					content,
					"after",
					searchRange,
				);
				if (!patch) {
					patch = patchFromScopedInsertion(workingText, content, searchRange);
				}
				attempt.outcome = patch ? "applied" : "no_patch";
				break;
			}
			case "add_at_end":
				patch = patchFromAddAtEnd(workingText, node.node, searchRange);
				attempt.outcome = patch ? "applied" : "no_patch";
				break;
		}

		attempt.patchApplied = patch !== null;
		operationAttempts.push(attempt);
		if (!patch) continue;
		patches.push(patch);
		workingText = applyPatch(workingText, patch);
	}

	if (patches.length === 0) {
		return {
			status: "unsupported",
			sectionPath,
			segments: [{ kind: "unchanged", text: sectionBody }],
			changes: [],
			deleted: [],
			inserted: [],
			debug: {
				sectionTextLength: sectionBody.length,
				operationCount: operations.length,
				operationAttempts,
				failureReason: "no_patches_applied",
			},
		};
	}

	return {
		status: "ok",
		sectionPath,
		segments: [{ kind: "unchanged", text: workingText }],
		changes: patches.map((patch) => ({
			deleted: patch.deleted,
			inserted: patch.inserted,
		})),
		deleted: patches
			.map((patch) => patch.deleted)
			.filter((text) => text.length > 0),
		inserted: patches
			.map((patch) => patch.inserted)
			.filter((text) => text.length > 0),
		debug: {
			sectionTextLength: sectionBody.length,
			operationCount: operations.length,
			operationAttempts,
			failureReason: null,
		},
	};
}
