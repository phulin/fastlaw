import {
	type EditNode,
	type EditTarget,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	PunctuationKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	type StructuralReference,
	UltimateEditKind,
} from "./amendment-edit-tree";
import {
	findHierarchyNodeByMarkerPath,
	parseMarkdownHierarchy,
} from "./markdown-hierarchy-parser";

interface ApplyEditTreeArgs {
	tree: InstructionSemanticTree;
	sectionPath: string;
	sectionBody: string;
	instructionText?: string;
}

type HierarchyLevel = {
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
			sentenceOrdinal?: number;
			content?: string;
			strikingContent?: string;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "delete";
			target?: HierarchyLevel[];
			sentenceOrdinal?: number;
			strikingContent?: string;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "insert_before";
			target?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: string;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert_after";
			target?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: string;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert";
			target?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: string;
	  }
	| {
			type: "add_at_end";
			target?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: string;
	  }
	| {
			type: "redesignate";
			target: HierarchyLevel[];
			fromLabel: string;
			toLabel: string;
	  }
	| {
			type: "move";
			fromTargets: HierarchyLevel[][];
			beforeTarget?: HierarchyLevel[];
			afterTarget?: HierarchyLevel[];
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

function getOperationTargetPath(
	operation: InstructionOperation,
): HierarchyLevel[] | undefined {
	if ("target" in operation) return operation.target;
	return undefined;
}

function getOperationSentenceOrdinal(
	operation: InstructionOperation,
): number | undefined {
	if ("sentenceOrdinal" in operation) return operation.sentenceOrdinal;
	return undefined;
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
	sentenceOrdinal: number | null;
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

function punctuationText(kind: PunctuationKind): string {
	switch (kind) {
		case PunctuationKind.Period:
			return ".";
		case PunctuationKind.Comma:
			return ",";
		case PunctuationKind.Semicolon:
			return ";";
	}
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
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.strike),
			);
			if (!strikingContent && scopedTarget.length === 0) {
				return {
					nodes: [],
					unsupportedReasons: ["strike_insert_unsupported_target"],
				};
			}
			const text = context.matterPreceding
				? `in the matter preceding ${context.matterPreceding.kind} (${context.matterPreceding.path.at(-1)?.label ?? ""}), by striking "${strikingContent}" and inserting "${edit.insert}"`
				: `by striking "${strikingContent}" and inserting "${edit.insert}"`;
			return {
				nodes: [
					makeNode(
						{
							type: "replace",
							target: scopedTarget,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							strikingContent: strikingContent ?? undefined,
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
			const throughContent = edit.through
				? textFromEditTarget(edit.through)
				: undefined;
			const throughPunctuation =
				edit.through && "punctuation" in edit.through
					? edit.through.punctuation
					: undefined;
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.target),
			);
			if (!strikingContent && scopedTarget.length === 0) {
				return {
					nodes: [],
					unsupportedReasons: ["strike_unsupported_target"],
				};
			}
			return {
				nodes: [
					makeNode(
						{
							type: "delete",
							target: scopedTarget,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							strikingContent: strikingContent ?? undefined,
							throughContent: throughContent ?? undefined,
							throughPunctuation,
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
				const anchorTarget = targetPathFromEditTarget(edit.before);
				const scopedAnchorTarget = anchorTarget
					? targetWithContext(anchorTarget)
					: undefined;
				if (!anchor && !scopedAnchorTarget) {
					return {
						nodes: [],
						unsupportedReasons: ["insert_before_unsupported_target"],
					};
				}
				return {
					nodes: [
						makeNode(
							{
								type: "insert_before",
								target: context.target,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: edit.content,
								anchorContent: anchor ?? undefined,
								anchorTarget: scopedAnchorTarget,
							},
							`by inserting "${edit.content}" before "${anchor ?? "target"}"`,
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
						nodes: [],
						unsupportedReasons: ["insert_after_unsupported_target"],
					};
				}
				return {
					nodes: [
						makeNode(
							{
								type: "insert_after",
								target: context.target,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: edit.content,
								anchorContent: anchor ?? undefined,
								anchorTarget: scopedAnchorTarget,
							},
							`by inserting "${edit.content}" after "${anchor ?? "target"}"`,
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
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
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
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
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
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
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
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							content: edit.content,
						},
						"to read as follows:",
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Redesignate:
			return {
				nodes: edit.mappings.map((mapping) => {
					const fromPath = targetWithContext(refToHierarchyPath(mapping.from));
					const toLabel =
						mapping.to.path[mapping.to.path.length - 1]?.label ?? "";
					const fromLabel =
						mapping.from.path[mapping.from.path.length - 1]?.label ?? "";
					return makeNode(
						{
							type: "redesignate",
							target: fromPath,
							fromLabel,
							toLabel,
						},
						`redesignating ${fromLabel} as ${toLabel}`,
					);
				}),
				unsupportedReasons: [],
			};
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
				return { nodes: [], unsupportedReasons: ["move_unsupported_target"] };
			}
			return {
				nodes: [
					makeNode(
						{
							type: "move",
							fromTargets,
							beforeTarget,
							afterTarget,
						},
						"moving target block",
					),
				],
				unsupportedReasons: [],
			};
		}
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
				sentenceOrdinal: context.sentenceOrdinal,
			});
			flattened.push(...nested.nodes);
			unsupportedReasons.push(...nested.unsupportedReasons);
			continue;
		}

		if (node.type === SemanticNodeType.LocationRestriction) {
			if (node.restriction.kind === LocationRestrictionKind.In) {
				if (node.restriction.refs.length === 0) {
					unsupportedReasons.push("in_location_empty_refs");
					continue;
				}
				for (const ref of node.restriction.refs) {
					const target = refToHierarchyPath(ref);
					const nested = walkTree(node.children, {
						target,
						matterPreceding: context.matterPreceding,
						unanchoredInsertMode: context.unanchoredInsertMode,
						sentenceOrdinal: context.sentenceOrdinal,
					});
					flattened.push(...nested.nodes);
					unsupportedReasons.push(...nested.unsupportedReasons);
				}
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterPreceding) {
				const target = refToHierarchyPath(node.restriction.ref);
				const nested = walkTree(node.children, {
					target,
					matterPreceding: node.restriction.ref,
					unanchoredInsertMode: context.unanchoredInsertMode,
					sentenceOrdinal: context.sentenceOrdinal,
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
					sentenceOrdinal: context.sentenceOrdinal,
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceOrdinal) {
				const nested = walkTree(node.children, {
					target: context.target,
					matterPreceding: context.matterPreceding,
					unanchoredInsertMode: context.unanchoredInsertMode,
					sentenceOrdinal: node.restriction.ordinal,
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
			(part): part is Exclude<HierarchyLevel, { type: "section" }> =>
				part.type !== "section",
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

function resolveScopeRange(
	text: string,
	target: HierarchyLevel[] | undefined,
): ScopeRange | null {
	const labels = normalizeTargetPath(target);
	if (labels.length === 0) {
		return { start: 0, end: text.length, targetLevel: null };
	}

	const lineStarts = getLineStarts(text);
	const parsed = parseMarkdownHierarchy(text);
	const node = findHierarchyNodeByMarkerPath(parsed.levels, labels);
	if (!node) return null;
	const startLine = parsed.paragraphs[node.startParagraph]?.startLine;
	if (typeof startLine !== "number") return null;
	const endLine =
		node.endParagraph >= parsed.paragraphs.length
			? lineStarts.length
			: parsed.paragraphs[node.endParagraph]?.startLine;
	if (typeof endLine !== "number") return null;
	const start = lineStarts[startLine] ?? 0;
	const end =
		endLine >= lineStarts.length
			? text.length
			: (lineStarts[endLine] ?? text.length);
	return { start, end, targetLevel: node.level };
}

function previewRange(text: string, range: ScopeRange | null): string | null {
	if (!range) return null;
	return text.slice(range.start, Math.min(range.end, range.start + 180));
}

function resolveSentenceOrdinalRange(
	text: string,
	ordinal: number,
): { start: number; end: number } | null {
	const matches = Array.from(text.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g));
	if (matches.length === 0) return null;
	const sentence = matches[ordinal - 1];
	if (!sentence) return null;
	const start = sentence.index ?? 0;
	const end = start + sentence[0].length;
	return { start, end };
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

function insertMovedBlock(text: string, index: number, block: string): string {
	const beforeChar = text[index - 1] ?? "";
	const afterChar = text[index] ?? "";
	const prefix = index === 0 || beforeChar === "\n" ? "" : "\n";
	const suffix = index >= text.length || afterChar === "\n" ? "" : "\n";
	return `${text.slice(0, index)}${prefix}${block}${suffix}${text.slice(index)}`;
}

function adjustIndexForRemovedRanges(
	index: number,
	removedRanges: Array<{ start: number; end: number }>,
): number | null {
	let adjusted = index;
	for (const range of removedRanges) {
		if (range.start < index && index < range.end) return null;
		if (range.end <= index) adjusted -= range.end - range.start;
	}
	return adjusted;
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
	const flattened = walkTree(args.tree.children, {
		target: [],
		matterPreceding: null,
		unanchoredInsertMode: /\badding at the end\b/i.test(
			args.instructionText ?? "",
		)
			? "add_at_end"
			: "insert",
		sentenceOrdinal: null,
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
		const targetPath = getOperationTargetPath(node.operation);
		const range = resolveScopeRange(workingText, targetPath);
		const hasExplicitTargetPath = Boolean(targetPath && targetPath.length > 0);
		const targetPathText =
			targetPath && targetPath.length > 0
				? targetPath.map((item) => `${item.type}:${item.val}`).join(" > ")
				: null;

		const sentenceOrdinal = getOperationSentenceOrdinal(node.operation);
		if (range && typeof sentenceOrdinal === "number") {
			const sentenceRange = resolveSentenceOrdinalRange(
				workingText.slice(range.start, range.end),
				sentenceOrdinal,
			);
			if (sentenceRange) {
				range.start += sentenceRange.start;
				range.end = range.start + (sentenceRange.end - sentenceRange.start);
			} else {
				range.start = range.end;
			}
		}

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
				if (!replacementContent) break;
				if (!strikingContent) {
					patch = {
						start: range.start,
						end: range.end,
						deleted: scopedText,
						inserted: replacementContent,
					};
					break;
				}
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
				if (!strikingContent) {
					patch = {
						start: range.start,
						end: range.end,
						deleted: scopedText,
						inserted: "",
					};
					break;
				}
				const localStart = scopedText.indexOf(strikingContent);
				attempt.searchText = strikingContent;
				attempt.searchTextKind = "striking";
				attempt.searchIndex = localStart >= 0 ? range.start + localStart : null;
				if (localStart < 0) break;
				let localEnd = localStart + strikingContent.length;
				const throughContent = node.operation.throughContent;
				if (throughContent) {
					const throughStart = scopedText.indexOf(
						throughContent,
						localStart + strikingContent.length,
					);
					if (throughStart < 0) break;
					localEnd = throughStart + throughContent.length;
				}
				const throughPunctuation = node.operation.throughPunctuation;
				if (throughPunctuation) {
					const punctuation = punctuationText(throughPunctuation);
					const punctuationIndex = scopedText.indexOf(
						punctuation,
						localStart + strikingContent.length,
					);
					if (punctuationIndex < 0) break;
					localEnd = punctuationIndex + punctuation.length;
				}
				let patchStart = range.start + localStart;
				let patchEnd = range.start + localEnd;
				if (throughContent || throughPunctuation) {
					const beforeChar = workingText[patchStart - 1] ?? "";
					const afterChar = workingText[patchEnd] ?? "";
					if (patchStart === 0 && afterChar === " ") {
						patchEnd += 1;
					} else if (
						patchStart > 0 &&
						beforeChar === " " &&
						afterChar === " "
					) {
						patchStart -= 1;
					}
				}
				patch = {
					start: patchStart,
					end: patchEnd,
					deleted: workingText.slice(patchStart, patchEnd),
					inserted: "",
				};
				break;
			}
			case "insert_before": {
				const anchor =
					node.operation.anchorContent ??
					(node.operation.anchorTarget
						? null
						: extractAnchor(node.text, "before"));
				const content = node.operation.content;
				if (!content) break;
				let anchorStart: number | null = null;
				if (anchor) {
					const localIndex = scopedText.indexOf(anchor);
					attempt.searchText = anchor;
					attempt.searchTextKind = "anchor_before";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
					if (localIndex >= 0) anchorStart = range.start + localIndex;
				} else if (node.operation.anchorTarget) {
					const anchorRange = resolveScopeRange(
						workingText,
						node.operation.anchorTarget,
					);
					if (anchorRange) anchorStart = anchorRange.start;
				}
				if (anchorStart === null) break;
				const value = anchor
					? `${content}${/[A-Za-z0-9)]$/.test(content) && /^[A-Za-z0-9(]/.test(anchor) ? " " : ""}`
					: `${content}${content.endsWith("\n") ? "" : "\n"}`;
				patch = {
					start: anchorStart,
					end: anchorStart,
					deleted: "",
					inserted: value,
				};
				break;
			}
			case "insert_after": {
				const anchor =
					node.operation.anchorContent ??
					(node.operation.anchorTarget
						? null
						: extractAnchor(node.text, "after"));
				const content = node.operation.content;
				if (!content) break;
				let anchorEnd: number | null = null;
				if (anchor) {
					const localIndex = scopedText.indexOf(anchor);
					attempt.searchText = anchor;
					attempt.searchTextKind = "anchor_after";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
					if (localIndex >= 0)
						anchorEnd = range.start + localIndex + anchor.length;
				} else if (node.operation.anchorTarget) {
					const anchorRange = resolveScopeRange(
						workingText,
						node.operation.anchorTarget,
					);
					if (anchorRange) anchorEnd = anchorRange.end;
				}
				if (anchorEnd === null) break;
				const value = anchor
					? `${/[A-Za-z0-9)]$/.test(anchor) && /^[A-Za-z0-9(]/.test(content) ? " " : ""}${content}`
					: `${workingText[anchorEnd - 1] === "\n" || anchorEnd === 0 ? "" : "\n"}${content}`;
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
			case "redesignate": {
				const marker = `(${node.operation.fromLabel})`;
				const replacement = `(${node.operation.toLabel})`;
				const localIndex = scopedText.indexOf(marker);
				attempt.searchText = marker;
				attempt.searchTextKind = "striking";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex < 0) break;
				patch = {
					start: range.start + localIndex,
					end: range.start + localIndex + marker.length,
					deleted: marker,
					inserted: replacement,
				};
				break;
			}
			case "move": {
				const fromRanges = node.operation.fromTargets
					.map((target) => resolveScopeRange(workingText, target))
					.filter((resolved): resolved is ScopeRange => resolved !== null)
					.map((resolved) => ({ start: resolved.start, end: resolved.end }));
				if (fromRanges.length !== node.operation.fromTargets.length) break;
				fromRanges.sort((left, right) => left.start - right.start);
				const movedBlock = fromRanges
					.map((resolved) =>
						workingText.slice(resolved.start, resolved.end).trim(),
					)
					.join("\n");
				if (movedBlock.length === 0) break;

				const anchorTarget =
					node.operation.afterTarget ?? node.operation.beforeTarget;
				if (!anchorTarget) break;
				const anchorRange = resolveScopeRange(workingText, anchorTarget);
				if (!anchorRange) break;
				const originalInsertIndex = node.operation.beforeTarget
					? anchorRange.start
					: anchorRange.end;
				let textWithoutMoved = workingText;
				for (let index = fromRanges.length - 1; index >= 0; index -= 1) {
					const segment = fromRanges[index];
					if (!segment) continue;
					textWithoutMoved = `${textWithoutMoved.slice(0, segment.start)}${textWithoutMoved.slice(segment.end)}`;
				}
				const adjustedInsertIndex = adjustIndexForRemovedRanges(
					originalInsertIndex,
					fromRanges,
				);
				if (adjustedInsertIndex === null) break;
				const movedText = insertMovedBlock(
					textWithoutMoved,
					adjustedInsertIndex,
					movedBlock,
				);
				patch = {
					start: 0,
					end: workingText.length,
					deleted: workingText,
					inserted: movedText,
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
