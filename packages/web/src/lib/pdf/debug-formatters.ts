import {
	type EditNode,
	type InstructionSemanticTree,
	type LocationRestrictionNode,
	type ScopeNode,
	SemanticNodeType,
} from "../amendment-edit-tree";
import type {
	ParsedInstruction,
	RuleAst,
} from "../handcrafted-instruction-parser";

const previewDebugText = (value: string) => value.replace(/\s+/g, " ").trim();

const formatAstNodeLines = (
	node: RuleAst,
	depth: number,
	lines: string[],
): void => {
	const indent = "  ".repeat(depth);
	lines.push(`${indent}- ${node.type}: ${previewDebugText(node.text)}`);
	for (const child of node.children) {
		formatAstNodeLines(child, depth + 1, lines);
	}
};

export const formatParseTree = (
	parsedInstruction: ParsedInstruction | null,
): string => {
	if (!parsedInstruction) {
		return "Parser did not match this instruction.";
	}
	const lines: string[] = [];
	formatAstNodeLines(parsedInstruction.ast, 0, lines);
	return lines.join("\n");
};

const describeEditTreeNode = (
	node: ScopeNode | LocationRestrictionNode | EditNode,
	depth: number,
	lines: string[],
): void => {
	const indent = "  ".repeat(depth);
	if (node.type === SemanticNodeType.Scope) {
		lines.push(`${indent}- scope ${node.scope.kind}(${node.scope.label})`);
		for (const child of node.children) {
			describeEditTreeNode(child, depth + 1, lines);
		}
		return;
	}
	if (node.type === SemanticNodeType.LocationRestriction) {
		lines.push(`${indent}- restriction ${node.restriction.kind}`);
		for (const child of node.children) {
			describeEditTreeNode(child, depth + 1, lines);
		}
		return;
	}
	lines.push(`${indent}- edit ${node.edit.kind}: ${JSON.stringify(node.edit)}`);
};

export const formatEditTree = (tree: InstructionSemanticTree): string => {
	const lines: string[] = [];
	lines.push(
		`targetScopePath: ${
			tree.targetScopePath
				?.map((segment) => `${segment.kind}(${segment.label})`)
				.join(" > ") ?? "n/a"
		}`,
	);
	lines.push(`targetSection: ${tree.targetSection ?? "n/a"}`);
	lines.push("---");
	for (const child of tree.children) {
		describeEditTreeNode(child, 0, lines);
	}
	if (tree.children.length === 0) {
		lines.push("No edit nodes.");
	}
	return lines.join("\n");
};
