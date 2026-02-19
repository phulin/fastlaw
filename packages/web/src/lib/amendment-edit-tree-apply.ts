import type {
	AmendatoryInstruction,
	HierarchyLevel,
	InstructionNode,
} from "./amendatory-instructions";
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
import type { AmendmentEffect } from "./amendment-effects";
import { computeAmendmentEffect } from "./amendment-effects";

interface ApplyEditTreeArgs {
	tree: InstructionSemanticTree;
	instruction: AmendatoryInstruction;
	sectionPath: string;
	sectionBody: string;
}

interface TraversalContext {
	target: HierarchyLevel[];
	matterPreceding: StructuralReference | null;
}

interface FlattenResult {
	nodes: InstructionNode[];
	unsupportedReasons: string[];
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
	return override;
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

function buildSyntheticInstruction(
	instruction: AmendatoryInstruction,
	tree: InstructionSemanticTree,
	nodes: InstructionNode[],
): AmendatoryInstruction {
	const rootQuery =
		tree.targetSection && tree.targetSection.length > 0
			? [{ type: "section", val: tree.targetSection } as const]
			: instruction.rootQuery;
	return {
		...instruction,
		rootQuery,
		tree: nodes,
	};
}

export function applyAmendmentEditTreeToSection(
	args: ApplyEditTreeArgs,
): AmendmentEffect {
	const flattened = walkTree(args.tree.children, {
		target: [],
		matterPreceding: null,
	});

	if (flattened.nodes.length === 0) {
		return {
			status: "unsupported",
			sectionPath: args.sectionPath,
			segments: [{ kind: "unchanged", text: args.sectionBody }],
			changes: [],
			deleted: [],
			inserted: [],
			debug: {
				sectionTextLength: args.sectionBody.length,
				operationCount: 0,
				operationAttempts: [],
				failureReason:
					flattened.unsupportedReasons[0] ?? "no_edit_tree_operations",
			},
		};
	}

	const synthetic = buildSyntheticInstruction(
		args.instruction,
		args.tree,
		flattened.nodes,
	);
	const effect = computeAmendmentEffect(
		synthetic,
		args.sectionPath,
		args.sectionBody,
	);
	if (effect.status === "ok") return effect;

	if (flattened.unsupportedReasons.length === 0) return effect;
	return {
		...effect,
		debug: {
			...effect.debug,
			failureReason:
				effect.debug.failureReason ?? flattened.unsupportedReasons[0],
		},
	};
}
