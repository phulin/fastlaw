import {
	type EditNode,
	type EditTarget,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	type StructuralReference,
	UltimateEditKind,
} from "./amendment-edit-tree";

interface ApplyEditTreeArgs {
	tree: InstructionSemanticTree;
	sectionPath: string;
	sectionBody: string;
	rootQuery?: HierarchyLevel[];
	instructionText?: string;
}

type HierarchyLevel =
	| { type: "none" }
	| {
			type:
				| "section"
				| "subsection"
				| "paragraph"
				| "subparagraph"
				| "clause"
				| "subclause"
				| "item"
				| "subitem";
			val: string;
	  };

type InstructionOperation =
	| {
			type: "replace";
			target?: HierarchyLevel[];
			content?: string;
			strikingContent?: string;
	  }
	| {
			type: "delete";
			target?: HierarchyLevel[];
			strikingContent?: string;
	  }
	| {
			type: "insert_before";
			target?: HierarchyLevel[];
			content?: string;
	  }
	| {
			type: "insert_after";
			target?: HierarchyLevel[];
			content?: string;
	  }
	| {
			type: "insert";
			target?: HierarchyLevel[];
			content?: string;
	  }
	| {
			type: "add_at_end";
			target?: HierarchyLevel[];
			content?: string;
	  };

interface InstructionNode {
	operation: InstructionOperation;
	children: InstructionNode[];
	text: string;
}

function getOperationStrikingContent(
	operation: InstructionOperation,
): string | null {
	if ("strikingContent" in operation) {
		return operation.strikingContent ?? null;
	}
	return null;
}

type AmendmentSegmentKind = "unchanged" | "deleted" | "inserted";

interface AmendmentEffectSegment {
	kind: AmendmentSegmentKind;
	text: string;
}

interface OperationMatchAttempt {
	operationType: string;
	nodeText: string;
	strikingContent: string | null;
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

interface AmendmentEffectDebug {
	sectionTextLength: number;
	operationCount: number;
	operationAttempts: OperationMatchAttempt[];
	failureReason: string | null;
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

interface TraversalContext {
	target: HierarchyLevel[];
	matterPreceding: StructuralReference | null;
	unanchoredInsertMode: "insert" | "add_at_end";
}

interface FlattenResult {
	nodes: InstructionNode[];
	unsupportedReasons: string[];
}

interface ScopeRange {
	start: number;
	end: number;
	targetLevel: number | null;
}

interface MarkerOccurrence {
	label: string;
	level: number;
	line: number;
}

interface TextPatch {
	start: number;
	end: number;
	deleted: string;
	inserted: string;
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
	const startsAtSection = override[0]?.type === "section";
	if (startsAtSection) return override;
	return [...base, ...override];
}

function textFromEditTarget(target: EditTarget): string | null {
	if ("kind" in target && target.kind === SearchTargetKind.Text) {
		return target.text;
	}
	return null;
}

function targetPathFromEditTarget(target: EditTarget): HierarchyLevel[] | null {
	if ("ref" in target) {
		return refToHierarchyPath(target.ref);
	}
	return null;
}

function makeNode(
	operation: InstructionNode["operation"],
	text: string,
): InstructionNode {
	return {
		operation,
		children: [],
		text,
	};
}

function looksLikeBlockContent(content: string): boolean {
	return /^[“”"']?\([^)]+\)/.test(content.trim());
}

function flattenEdit(
	editNode: EditNode,
	context: TraversalContext,
): FlattenResult {
	const edit = editNode.edit;
	const targetWithContext = (path: HierarchyLevel[] | null): HierarchyLevel[] =>
		mergeTargets(context.target, path);

	switch (edit.kind) {
		case UltimateEditKind.StrikeInsert: {
			const strikingContent = textFromEditTarget(edit.strike);
			if (!strikingContent) {
				return {
					nodes: [],
					unsupportedReasons: ["strike_insert_non_text_target"],
				};
			}
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.strike),
			);
			const text = context.matterPreceding
				? `in the matter preceding ${context.matterPreceding.kind} (${context.matterPreceding.path.at(-1)?.label ?? ""}), by striking "${strikingContent}" and inserting "${edit.insert}"`
				: `by striking "${strikingContent}" and inserting "${edit.insert}"`;
			return {
				nodes: [
					makeNode(
						{
							type: "replace",
							target: scopedTarget,
							strikingContent,
							content: edit.insert,
						},
						text,
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Strike: {
			const strikingContent = textFromEditTarget(edit.target);
			if (!strikingContent || edit.through) {
				return {
					nodes: [],
					unsupportedReasons: ["strike_non_text_or_through"],
				};
			}
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.target),
			);
			return {
				nodes: [
					makeNode(
						{
							type: "delete",
							target: scopedTarget,
							strikingContent,
						},
						`by striking "${strikingContent}"`,
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Insert: {
			if (edit.before) {
				const anchor = textFromEditTarget(edit.before);
				if (!anchor) {
					return { nodes: [], unsupportedReasons: ["insert_before_non_text"] };
				}
				return {
					nodes: [
						makeNode(
							{
								type: "insert_before",
								target: context.target,
								content: edit.content,
							},
							`by inserting "${edit.content}" before "${anchor}"`,
						),
					],
					unsupportedReasons: [],
				};
			}
			if (edit.after) {
				const anchor = textFromEditTarget(edit.after);
				if (!anchor) {
					return { nodes: [], unsupportedReasons: ["insert_after_non_text"] };
				}
				return {
					nodes: [
						makeNode(
							{
								type: "insert_after",
								target: context.target,
								content: edit.content,
							},
							`by inserting "${edit.content}" after "${anchor}"`,
						),
					],
					unsupportedReasons: [],
				};
			}
			if (edit.atEndOf) {
				const scopedTarget = refToHierarchyPath(edit.atEndOf);
				return {
					nodes: [
						makeNode(
							{
								type: "add_at_end",
								target: targetWithContext(scopedTarget),
								content: edit.content,
							},
							"by adding at the end the following",
						),
					],
					unsupportedReasons: [],
				};
			}
			if (
				context.unanchoredInsertMode === "add_at_end" ||
				looksLikeBlockContent(edit.content)
			) {
				return {
					nodes: [
						makeNode(
							{
								type: "add_at_end",
								target: context.target,
								content: edit.content,
							},
							"by adding at the end the following",
						),
					],
					unsupportedReasons: [],
				};
			}
			return {
				nodes: [
					makeNode(
						{
							type: "insert",
							target: context.target,
							content: edit.content,
						},
						"by inserting",
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Rewrite: {
			const rewriteTarget = edit.target
				? targetWithContext(refToHierarchyPath(edit.target))
				: context.target;
			return {
				nodes: [
					makeNode(
						{
							type: "replace",
							target: rewriteTarget,
							content: edit.content,
						},
						"to read as follows:",
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Redesignate:
			return { nodes: [], unsupportedReasons: ["redesignate_not_supported"] };
		case UltimateEditKind.Move:
			return { nodes: [], unsupportedReasons: ["move_not_supported"] };
	}
}

function walkTree(
	nodes: InstructionSemanticTree["children"],
	context: TraversalContext,
): FlattenResult {
	const flattened: InstructionNode[] = [];
	const unsupportedReasons: string[] = [];

	for (const node of nodes) {
		if (node.type === SemanticNodeType.Scope) {
			const scopeTarget = [
				...context.target,
				{ type: toHierarchyType(node.scope.kind), val: node.scope.label },
			] as HierarchyLevel[];
			const nested = walkTree(node.children, {
				target: scopeTarget,
				matterPreceding: context.matterPreceding,
				unanchoredInsertMode: context.unanchoredInsertMode,
			});
			flattened.push(...nested.nodes);
			unsupportedReasons.push(...nested.unsupportedReasons);
			continue;
		}

		if (node.type === SemanticNodeType.LocationRestriction) {
			if (node.restriction.kind === LocationRestrictionKind.In) {
				if (node.restriction.refs.length !== 1) {
					unsupportedReasons.push("in_location_multi_ref_not_supported");
					continue;
				}
				const target = refToHierarchyPath(node.restriction.refs[0]);
				const nested = walkTree(node.children, {
					target,
					matterPreceding: context.matterPreceding,
					unanchoredInsertMode: context.unanchoredInsertMode,
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterPreceding) {
				const target = refToHierarchyPath(node.restriction.ref);
				const nested = walkTree(node.children, {
					target,
					matterPreceding: node.restriction.ref,
					unanchoredInsertMode: context.unanchoredInsertMode,
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.AtEnd) {
				const target = node.restriction.ref
					? refToHierarchyPath(node.restriction.ref)
					: context.target;
				const nested = walkTree(node.children, {
					target,
					matterPreceding: context.matterPreceding,
					unanchoredInsertMode: "add_at_end",
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}

			unsupportedReasons.push(
				`location_${node.restriction.kind}_not_supported`,
			);
			continue;
		}

		if (node.type === SemanticNodeType.Edit) {
			const result = flattenEdit(node, context);
			flattened.push(...result.nodes);
			unsupportedReasons.push(...result.unsupportedReasons);
		}
	}

	return { nodes: flattened, unsupportedReasons };
}

function normalizeTargetPath(target: HierarchyLevel[] | undefined): string[] {
	if (!target) return [];
	return target
		.filter(
			(part): part is Exclude<HierarchyLevel, { type: "none" | "section" }> =>
				part.type !== "section" && part.type !== "none",
		)
		.map((part) => part.val);
}

function getLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function splitIntoLines(text: string): string[] {
	return text.split("\n");
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

function buildMarkerOccurrences(lines: string[]): MarkerOccurrence[] {
	const occurrences: MarkerOccurrence[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		const depth = countLeadingQuoteDepth(line);
		const labels = extractLeadingLabels(line);
		for (let markerIndex = 0; markerIndex < labels.length; markerIndex++) {
			const label = labels[markerIndex];
			if (!label) continue;
			occurrences.push({
				label,
				level: depth + markerIndex,
				line: lineIndex,
			});
		}
	}
	return occurrences;
}

function findBoundaryLine(
	occurrences: MarkerOccurrence[],
	index: number,
	maxEndLine: number,
): number {
	const current = occurrences[index];
	if (!current) return maxEndLine;
	for (let i = index + 1; i < occurrences.length; i++) {
		const next = occurrences[i];
		if (!next) continue;
		if (next.line >= maxEndLine) break;
		if (next.line > current.line && next.level <= current.level) {
			return next.line;
		}
	}
	return maxEndLine;
}

function resolveScopeRange(
	text: string,
	target: HierarchyLevel[] | undefined,
): ScopeRange | null {
	const labels = normalizeTargetPath(target);
	if (labels.length === 0) {
		return { start: 0, end: text.length, targetLevel: null };
	}

	const lines = splitIntoLines(text);
	const lineStarts = getLineStarts(text);
	const occurrences = buildMarkerOccurrences(lines);
	if (occurrences.length === 0) return null;

	let rangeStartLine = 0;
	let rangeEndLine = lines.length;
	let selectedOccurrence: MarkerOccurrence | null = null;

	for (const rawLabel of labels) {
		const label = rawLabel.toLowerCase();
		let selectedIndex = -1;
		for (let i = 0; i < occurrences.length; i++) {
			const occurrence = occurrences[i];
			if (!occurrence) continue;
			if (occurrence.line < rangeStartLine || occurrence.line >= rangeEndLine)
				continue;
			if (occurrence.label.toLowerCase() !== label) continue;
			selectedIndex = i;
			break;
		}
		if (selectedIndex < 0) return null;
		selectedOccurrence = occurrences[selectedIndex] ?? null;
		if (!selectedOccurrence) return null;
		rangeStartLine = selectedOccurrence.line;
		rangeEndLine = findBoundaryLine(occurrences, selectedIndex, rangeEndLine);
	}

	const start = lineStarts[rangeStartLine] ?? 0;
	const end =
		rangeEndLine >= lines.length
			? text.length
			: (lineStarts[rangeEndLine] ?? text.length);
	return { start, end, targetLevel: selectedOccurrence?.level ?? null };
}

function previewRange(text: string, range: ScopeRange | null): string | null {
	if (!range) return null;
	return text.slice(range.start, Math.min(range.end, range.start + 180));
}

function extractAnchor(
	nodeText: string,
	direction: "before" | "after",
): string | null {
	const pattern = new RegExp(`${direction}\\s+["“”„‟'‘]([^"”'’]+)["”'’]`, "i");
	const match = nodeText.match(pattern);
	return match?.[1] ?? null;
}

function applyPatch(text: string, patch: TextPatch): string {
	return `${text.slice(0, patch.start)}${patch.inserted}${text.slice(patch.end)}`;
}

function rankForMarkerLabel(label: string): number {
	if (/^[a-z]+$/.test(label) && !/^[ivxlcdm]+$/.test(label)) return 1;
	if (/^\d+$/.test(label)) return 2;
	if (/^[A-Z]+$/.test(label) && !/^[IVXLCDM]+$/.test(label)) return 3;
	if (/^[ivxlcdm]+$/.test(label)) return 4;
	if (/^[IVXLCDM]+$/.test(label)) return 5;
	return 6;
}

function quotePrefix(level: number): string {
	if (level <= 0) return "";
	return `${Array.from({ length: level }, () => ">").join(" ")} `;
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

function sanitizeQuotedLine(line: string): string {
	return line
		.trim()
		.replace(/^[“”"'‘’]+/, "")
		.replace(/[“”"'‘’]+[.;,]*$/, "")
		.trim();
}

function formatBlockInsertContent(
	content: string,
	targetLevel: number,
): string {
	const rawLines = content.split("\n");
	const markerMatches = rawLines
		.map((line) => sanitizeQuotedLine(line).match(/^\(([^)]+)\)\s*(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (markerMatches.length === 0) return content;

	const markerRanks = markerMatches.map((match) =>
		rankForMarkerLabel(match[1] ?? ""),
	);
	const minRank = Math.min(...markerRanks);
	const formattedLines: string[] = [];
	let markerIndex = 0;
	let activeLevel = targetLevel + 1;

	for (const rawLine of rawLines) {
		const cleaned = sanitizeQuotedLine(rawLine);
		if (cleaned.length === 0) {
			formattedLines.push("");
			continue;
		}
		const markerMatch = cleaned.match(/^\(([^)]+)\)\s*(.*)$/);
		if (!markerMatch) {
			formattedLines.push(`${quotePrefix(activeLevel)}${cleaned}`);
			continue;
		}

		const marker = markerMatch[1] ?? "";
		const rest = markerMatch[2] ?? "";
		const markerRank = markerRanks[markerIndex] ?? minRank;
		markerIndex += 1;
		activeLevel = targetLevel + 1 + (markerRank - minRank);
		const headingSplit = splitHeadingFromBody(rest);
		if (headingSplit) {
			formattedLines.push(
				`${quotePrefix(activeLevel)}**(${marker})** **${headingSplit.heading}**`,
			);
			if (headingSplit.body) {
				formattedLines.push(`${quotePrefix(activeLevel)}${headingSplit.body}`);
			}
			continue;
		}

		formattedLines.push(
			`${quotePrefix(activeLevel)}**(${marker})**${rest ? ` ${rest}` : ""}`,
		);
	}

	return formattedLines.join("\n");
}

function makeUnsupportedResult(
	args: ApplyEditTreeArgs,
	operationCount: number,
	operationAttempts: OperationMatchAttempt[],
	reason: string,
): AmendmentEffect {
	return {
		status: "unsupported",
		sectionPath: args.sectionPath,
		segments: [{ kind: "unchanged", text: args.sectionBody }],
		changes: [],
		deleted: [],
		inserted: [],
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount,
			operationAttempts,
			failureReason: reason,
		},
	};
}

export function applyAmendmentEditTreeToSection(
	args: ApplyEditTreeArgs,
): AmendmentEffect {
	const fallbackRootQuery: HierarchyLevel[] =
		args.tree.targetSection && args.tree.targetSection.length > 0
			? [{ type: "section", val: args.tree.targetSection }]
			: [];
	const rootQuery =
		(args.rootQuery ?? []).length > 0
			? (args.rootQuery ?? [])
			: fallbackRootQuery;
	const flattened = walkTree(args.tree.children, {
		target: rootQuery,
		matterPreceding: null,
		unanchoredInsertMode: /\badding at the end\b/i.test(
			args.instructionText ?? "",
		)
			? "add_at_end"
			: "insert",
	});

	if (flattened.nodes.length === 0) {
		return makeUnsupportedResult(
			args,
			0,
			[],
			flattened.unsupportedReasons[0] ?? "no_edit_tree_operations",
		);
	}

	let workingText = args.sectionBody;
	const changes: Array<{ deleted: string; inserted: string }> = [];
	const deleted: string[] = [];
	const inserted: string[] = [];
	const operationAttempts: OperationMatchAttempt[] = [];

	for (const node of flattened.nodes) {
		const targetPath = node.operation.target;
		const range = resolveScopeRange(workingText, targetPath);
		const hasExplicitTargetPath = Boolean(targetPath && targetPath.length > 0);
		const targetPathText =
			targetPath && targetPath.length > 0
				? targetPath
						.filter(
							(item): item is Exclude<HierarchyLevel, { type: "none" }> =>
								item.type !== "none",
						)
						.map((item) => `${item.type}:${item.val}`)
						.join(" > ")
				: null;

		const attempt: OperationMatchAttempt = {
			operationType: node.operation.type,
			nodeText: node.text,
			strikingContent: getOperationStrikingContent(node.operation),
			targetPath: targetPathText,
			hasExplicitTargetPath,
			scopedRange: range
				? {
						start: range.start,
						end: range.end,
						length: range.end - range.start,
						preview: previewRange(workingText, range) ?? "",
					}
				: null,
			searchText: null,
			searchTextKind: "none",
			searchIndex: null,
			patchApplied: false,
			outcome: "no_patch",
		};

		if (!range) {
			attempt.outcome = "scope_unresolved";
			operationAttempts.push(attempt);
			continue;
		}

		const scopedText = workingText.slice(range.start, range.end);
		let patch: TextPatch | null = null;

		switch (node.operation.type) {
			case "replace": {
				const strikingContent = node.operation.strikingContent;
				const replacementContent = node.operation.content;
				if (!strikingContent || !replacementContent) break;
				const localIndex = scopedText.indexOf(strikingContent);
				attempt.searchText = strikingContent;
				attempt.searchTextKind = "striking";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex < 0) break;
				patch = {
					start: range.start + localIndex,
					end: range.start + localIndex + strikingContent.length,
					deleted: strikingContent,
					inserted: replacementContent,
				};
				break;
			}
			case "delete": {
				const strikingContent = node.operation.strikingContent;
				if (!strikingContent) break;
				const localIndex = scopedText.indexOf(strikingContent);
				attempt.searchText = strikingContent;
				attempt.searchTextKind = "striking";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex < 0) break;
				patch = {
					start: range.start + localIndex,
					end: range.start + localIndex + strikingContent.length,
					deleted: strikingContent,
					inserted: "",
				};
				break;
			}
			case "insert_before": {
				const anchor = extractAnchor(node.text, "before");
				const content = node.operation.content;
				if (!anchor || !content) break;
				const localIndex = scopedText.indexOf(anchor);
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_before";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex < 0) break;
				const anchorStart = range.start + localIndex;
				const needsSpace =
					/[A-Za-z0-9)]$/.test(content) && /^[A-Za-z0-9(]/.test(anchor);
				const value = `${content}${needsSpace ? " " : ""}`;
				patch = {
					start: anchorStart,
					end: anchorStart,
					deleted: "",
					inserted: value,
				};
				break;
			}
			case "insert_after": {
				const anchor = extractAnchor(node.text, "after");
				const content = node.operation.content;
				if (!anchor || !content) break;
				const localIndex = scopedText.indexOf(anchor);
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_after";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex < 0) break;
				const anchorEnd = range.start + localIndex + anchor.length;
				const needsLeadingSpace =
					/[A-Za-z0-9)]$/.test(anchor) && /^[A-Za-z0-9(]/.test(content);
				const value = `${needsLeadingSpace ? " " : ""}${content}`;
				patch = {
					start: anchorEnd,
					end: anchorEnd,
					deleted: "",
					inserted: value,
				};
				break;
			}
			case "insert": {
				const content = node.operation.content;
				if (!content) break;
				const insertAt = range.end;
				const beforeChar = workingText[insertAt - 1] ?? "";
				const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
				patch = {
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: `${prefix}${content}`,
				};
				break;
			}
			case "add_at_end": {
				const content = node.operation.content;
				if (!content) break;
				const insertAt = range.end;
				const beforeChar = workingText[insertAt - 1] ?? "";
				const afterChar = workingText[insertAt] ?? "";
				const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
				const formatted = formatBlockInsertContent(
					content,
					range.targetLevel ?? 0,
				);
				const suffix = afterChar && afterChar !== "\n" ? "\n\n" : "\n";
				patch = {
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: `${prefix}${formatted}${suffix}`,
				};
				break;
			}
		}

		if (!patch) {
			attempt.patchApplied = false;
			attempt.outcome = "no_patch";
			operationAttempts.push(attempt);
			continue;
		}

		attempt.patchApplied = true;
		attempt.outcome = "applied";
		operationAttempts.push(attempt);
		workingText = applyPatch(workingText, patch);
		changes.push({ deleted: patch.deleted, inserted: patch.inserted });
		if (patch.deleted.length > 0) deleted.push(patch.deleted);
		if (patch.inserted.length > 0) inserted.push(patch.inserted);
	}

	if (changes.length === 0) {
		return makeUnsupportedResult(
			args,
			flattened.nodes.length,
			operationAttempts,
			flattened.unsupportedReasons[0] ?? "no_patches_applied",
		);
	}

	return {
		status: "ok",
		sectionPath: args.sectionPath,
		segments: [{ kind: "unchanged", text: workingText }],
		changes,
		deleted,
		inserted,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount: flattened.nodes.length,
			operationAttempts,
			failureReason: null,
		},
	};
}
