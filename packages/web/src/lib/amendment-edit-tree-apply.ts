import { buildAmendmentDocumentModel } from "./amendment-document-model";
import { applyPlannedPatchesTransaction } from "./amendment-edit-apply-transaction";
import {
	ParagraphRanges,
	type ResolutionIssue,
} from "./amendment-edit-engine-types";
import { planEdits } from "./amendment-edit-planner";
import {
	type EditNode,
	type EditTarget,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	type PunctuationKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	type StructuralReference,
	UltimateEditKind,
} from "./amendment-edit-tree";
import { resolveInstructionOperations } from "./amendment-selector-resolver";
import { type MarkdownReplacementRange, renderMarkdown } from "./markdown";

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
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			throughTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: ParagraphRanges;
			strikingContent?: string;
			eachPlaceItAppears?: boolean;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "delete";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			throughTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			strikingContent?: string;
			eachPlaceItAppears?: boolean;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "insert_before";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: ParagraphRanges;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert_after";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: ParagraphRanges;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: ParagraphRanges;
	  }
	| {
			type: "add_at_end";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: ParagraphRanges;
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
	pipeline: {
		resolvedOperationCount: number;
		plannedPatchCount: number;
		resolutionIssueCount: number;
		resolutionIssues: ResolutionIssue[];
	};
}

export type ApplyFailureReasonKind =
	| "target_unresolved"
	| "target_ambiguous"
	| "scope_unresolved"
	| "no_match";

export interface FailedApplyItem {
	operationIndex: number;
	operationType: string;
	text: string;
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">;
	targetPath: string | null;
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
}

export interface AmendmentApplySummary {
	partiallyApplied: boolean;
	failedItems: FailedApplyItem[];
}

export interface AmendmentEffect {
	status: "ok" | "unsupported";
	sectionPath: string;
	segments: AmendmentEffectSegment[];
	changes: Array<{ deleted: string; inserted: string }>;
	deleted: string[];
	inserted: string[];
	replacements?: MarkdownReplacementRange[];
	annotatedHtml?: string;
	applySummary: AmendmentApplySummary;
	debug: AmendmentEffectDebug;
}

interface TraversalContext {
	target: HierarchyLevel[];
	matterPreceding: StructuralReference | null;
	matterPrecedingTarget: HierarchyLevel[] | null;
	matterFollowingTarget: HierarchyLevel[] | null;
	unanchoredInsertMode: "insert" | "add_at_end";
	sentenceOrdinal: number | null;
}

interface FlattenResult {
	nodes: InstructionNode[];
	unsupportedReasons: string[];
}

function mapIssueToFailureReason(
	issue: ResolutionIssue | undefined,
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">,
): {
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
} {
	if (issue) {
		const hasCandidates =
			issue.candidateNodeIds !== undefined && issue.candidateNodeIds.length > 0;
		if (issue.kind.endsWith("_ambiguous")) {
			return {
				reasonKind: "target_ambiguous",
				reason: "Target path was ambiguous.",
				reasonDetail: hasCandidates
					? `${issue.path} [candidates=${issue.candidateNodeIds?.join(", ")}]`
					: issue.path,
			};
		}
		return {
			reasonKind: "target_unresolved",
			reason: "Target path did not resolve.",
			reasonDetail: issue.path,
		};
	}
	if (outcome === "scope_unresolved") {
		return {
			reasonKind: "scope_unresolved",
			reason: "Scope could not be resolved.",
			reasonDetail: null,
		};
	}
	return {
		reasonKind: "no_match",
		reason: "No matching text or anchor found in resolved scope.",
		reasonDetail: null,
	};
}

function buildApplySummary(
	operationAttempts: OperationMatchAttempt[],
	resolutionIssues: ResolutionIssue[],
): AmendmentApplySummary {
	const issueByOperationIndex = new Map<number, ResolutionIssue>();
	for (const issue of resolutionIssues) {
		if (!issueByOperationIndex.has(issue.operationIndex)) {
			issueByOperationIndex.set(issue.operationIndex, issue);
		}
	}
	const failedItems: FailedApplyItem[] = [];
	for (
		let operationIndex = 0;
		operationIndex < operationAttempts.length;
		operationIndex += 1
	) {
		const attempt = operationAttempts[operationIndex];
		if (!attempt || attempt.outcome === "applied") continue;
		const failure = mapIssueToFailureReason(
			issueByOperationIndex.get(operationIndex),
			attempt.outcome,
		);
		failedItems.push({
			operationIndex,
			operationType: attempt.operationType,
			text: attempt.nodeText,
			outcome: attempt.outcome,
			targetPath: attempt.targetPath,
			reasonKind: failure.reasonKind,
			reason: failure.reason,
			reasonDetail: failure.reasonDetail,
		});
	}
	return {
		partiallyApplied: failedItems.length > 0,
		failedItems,
	};
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

interface TextSearchTargetPayload {
	text: string;
	eachPlaceItAppears: boolean;
}

function textSearchFromEditTarget(
	target: EditTarget,
): TextSearchTargetPayload | null {
	if ("kind" in target && target.kind === SearchTargetKind.Text) {
		return {
			text: target.text,
			eachPlaceItAppears: target.eachPlaceItAppears ?? false,
		};
	}
	return null;
}

function textFromEditTarget(target: EditTarget): string | null {
	return textSearchFromEditTarget(target)?.text ?? null;
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
	const optionalTargetWithContext = (
		path: HierarchyLevel[] | null,
	): HierarchyLevel[] => (path ? mergeTargets(context.target, path) : []);

	switch (edit.kind) {
		case UltimateEditKind.StrikeInsert: {
			const strikeTarget = textSearchFromEditTarget(edit.strike);
			const strikingContent = strikeTarget?.text ?? null;
			const scopedTarget = targetWithContext(
				targetPathFromEditTarget(edit.strike),
			);
			const scopedThroughTarget = optionalTargetWithContext(
				throughTargetPathFromEditTarget(edit.strike),
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
							matterPrecedingTarget: context.matterPrecedingTarget ?? undefined,
							matterFollowingTarget: context.matterFollowingTarget ?? undefined,
							throughTarget:
								scopedThroughTarget.length > 0
									? scopedThroughTarget
									: undefined,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							strikingContent: strikingContent ?? undefined,
							eachPlaceItAppears: strikeTarget?.eachPlaceItAppears || undefined,
							content: ParagraphRanges.fromText(edit.insert),
						},
						text,
					),
				],
				unsupportedReasons: [],
			};
		}
		case UltimateEditKind.Strike: {
			const strikeTarget = textSearchFromEditTarget(edit.target);
			const strikingContent = strikeTarget?.text ?? null;
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
			const scopedThroughTarget = optionalTargetWithContext(
				throughTargetPathFromEditTarget(edit.target),
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
							matterPrecedingTarget: context.matterPrecedingTarget ?? undefined,
							matterFollowingTarget: context.matterFollowingTarget ?? undefined,
							throughTarget:
								scopedThroughTarget.length > 0
									? scopedThroughTarget
									: undefined,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							strikingContent: strikingContent ?? undefined,
							eachPlaceItAppears: strikeTarget?.eachPlaceItAppears || undefined,
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
								matterPrecedingTarget:
									context.matterPrecedingTarget ?? undefined,
								matterFollowingTarget:
									context.matterFollowingTarget ?? undefined,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: ParagraphRanges.fromText(edit.content),
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
								matterPrecedingTarget:
									context.matterPrecedingTarget ?? undefined,
								matterFollowingTarget:
									context.matterFollowingTarget ?? undefined,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: ParagraphRanges.fromText(edit.content),
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
								matterPrecedingTarget:
									context.matterPrecedingTarget ?? undefined,
								matterFollowingTarget:
									context.matterFollowingTarget ?? undefined,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: ParagraphRanges.fromText(edit.content),
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
								matterPrecedingTarget:
									context.matterPrecedingTarget ?? undefined,
								matterFollowingTarget:
									context.matterFollowingTarget ?? undefined,
								sentenceOrdinal: context.sentenceOrdinal ?? undefined,
								content: ParagraphRanges.fromText(edit.content),
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
							matterPrecedingTarget: context.matterPrecedingTarget ?? undefined,
							matterFollowingTarget: context.matterFollowingTarget ?? undefined,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							content: ParagraphRanges.fromText(edit.content),
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
							matterPrecedingTarget: context.matterPrecedingTarget ?? undefined,
							matterFollowingTarget: context.matterFollowingTarget ?? undefined,
							sentenceOrdinal: context.sentenceOrdinal ?? undefined,
							content: ParagraphRanges.fromText(edit.content),
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
				matterPrecedingTarget: context.matterPrecedingTarget,
				matterFollowingTarget: context.matterFollowingTarget,
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
						matterPrecedingTarget: context.matterPrecedingTarget,
						matterFollowingTarget: context.matterFollowingTarget,
						unanchoredInsertMode: context.unanchoredInsertMode,
						sentenceOrdinal: context.sentenceOrdinal,
					});
					flattened.push(...nested.nodes);
					unsupportedReasons.push(...nested.unsupportedReasons);
				}
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterPreceding) {
				const matterPrecedingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				const nested = walkTree(node.children, {
					target: context.target,
					matterPreceding: node.restriction.ref,
					matterPrecedingTarget,
					matterFollowingTarget: context.matterFollowingTarget,
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
					matterPrecedingTarget: context.matterPrecedingTarget,
					matterFollowingTarget: context.matterFollowingTarget,
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
					matterPrecedingTarget: context.matterPrecedingTarget,
					matterFollowingTarget: context.matterFollowingTarget,
					unanchoredInsertMode: context.unanchoredInsertMode,
					sentenceOrdinal: node.restriction.ordinal,
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.SentenceLast) {
				const nested = walkTree(node.children, {
					target: context.target,
					matterPreceding: context.matterPreceding,
					matterPrecedingTarget: context.matterPrecedingTarget,
					matterFollowingTarget: context.matterFollowingTarget,
					unanchoredInsertMode: context.unanchoredInsertMode,
					sentenceOrdinal: -1,
				});
				flattened.push(...nested.nodes);
				unsupportedReasons.push(...nested.unsupportedReasons);
				continue;
			}
			if (node.restriction.kind === LocationRestrictionKind.MatterFollowing) {
				const matterFollowingTarget = mergeTargets(
					context.target,
					refToHierarchyPath(node.restriction.ref),
				);
				const nested = walkTree(node.children, {
					target: context.target,
					matterPreceding: context.matterPreceding,
					matterPrecedingTarget: context.matterPrecedingTarget,
					matterFollowingTarget,
					unanchoredInsertMode: context.unanchoredInsertMode,
					sentenceOrdinal: context.sentenceOrdinal,
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

function makeUnsupportedResult(
	args: ApplyEditTreeArgs,
	operationCount: number,
	operationAttempts: OperationMatchAttempt[],
	reason: string,
	pipeline?: {
		resolvedOperationCount: number;
		plannedPatchCount: number;
		resolutionIssues: ResolutionIssue[];
	},
): AmendmentEffect {
	const resolvedOperationCount = pipeline?.resolvedOperationCount ?? 0;
	const plannedPatchCount = pipeline?.plannedPatchCount ?? 0;
	const resolutionIssues = pipeline?.resolutionIssues ?? [];
	const applySummary = buildApplySummary(operationAttempts, resolutionIssues);
	return {
		status: "unsupported",
		sectionPath: args.sectionPath,
		segments: [{ kind: "unchanged", text: args.sectionBody }],
		changes: [],
		deleted: [],
		inserted: [],
		replacements: [],
		annotatedHtml: renderMarkdown(args.sectionBody),
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount,
			operationAttempts,
			failureReason: reason,
			pipeline: {
				resolvedOperationCount,
				plannedPatchCount,
				resolutionIssueCount: resolutionIssues.length,
				resolutionIssues,
			},
		},
	};
}

export function applyAmendmentEditTreeToSection(
	args: ApplyEditTreeArgs,
): AmendmentEffect {
	const flattened = walkTree(args.tree.children, {
		target: [],
		matterPreceding: null,
		matterPrecedingTarget: null,
		matterFollowingTarget: null,
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
			{
				resolvedOperationCount: 0,
				plannedPatchCount: 0,
				resolutionIssues: [],
			},
		);
	}

	let workingText = args.sectionBody;
	const model = buildAmendmentDocumentModel(args.sectionBody);
	const { resolved, issues } = resolveInstructionOperations(
		model,
		flattened.nodes,
	);
	const { patches, attempts } = planEdits(model, args.sectionBody, resolved);
	const applied = applyPlannedPatchesTransaction(args.sectionBody, patches);
	workingText = applied.text;
	const replacements = applied.replacements;

	const changes = patches.map((patch) => ({
		deleted: patch.deleted,
		inserted: patch.inserted.toText(),
	}));
	const deleted = patches
		.map((patch) => patch.deleted)
		.filter((value) => value.length > 0);
	const inserted = patches
		.map((patch) => patch.inserted.toText())
		.filter((value) => value.length > 0);
	const operationAttempts = attempts;
	const applySummary = buildApplySummary(operationAttempts, issues);

	if (changes.length === 0) {
		return makeUnsupportedResult(
			args,
			flattened.nodes.length,
			operationAttempts,
			flattened.unsupportedReasons[0] ??
				issues[0]?.kind ??
				"no_patches_applied",
			{
				resolvedOperationCount: resolved.length,
				plannedPatchCount: patches.length,
				resolutionIssues: issues,
			},
		);
	}

	return {
		status: "ok",
		sectionPath: args.sectionPath,
		segments: [{ kind: "unchanged", text: workingText }],
		changes,
		deleted,
		inserted,
		replacements,
		annotatedHtml: renderMarkdown(workingText, { replacements }),
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount: flattened.nodes.length,
			operationAttempts,
			failureReason: null,
			pipeline: {
				resolvedOperationCount: resolved.length,
				plannedPatchCount: patches.length,
				resolutionIssueCount: issues.length,
				resolutionIssues: issues,
			},
		},
	};
}
