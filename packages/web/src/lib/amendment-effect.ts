import type {
	AmendatoryInstruction,
	HierarchyLevel,
	InstructionNode,
} from "./amendatory-instructions";
import type { NodeContent, NodeRecord } from "./types";

// ============================================================================
// Data Structures for Amendment Effect Computation
// ============================================================================

/**
 * A segment of text with a marker indicating whether it's existing, inserted, or deleted.
 */
export interface TextSegment {
	text: string;
	type: "existing" | "inserted" | "deleted";
	hierarchyLabel?: string; // e.g., "(a)", "(1)", "(A)"
}

/**
 * Represents a block of statutory content with hierarchy information.
 * This mirrors the ContentBlock structure but with additional metadata.
 */
export interface StatutoryBlock {
	type: string; // e.g., "chapeau", "content", "continuation"
	label?: string; // e.g., "(a)", "(1)", "(A)"
	content?: string;
	level?: HierarchyLevel;
	children?: StatutoryBlock[];
}

/**
 * A single operation within an amendment effect.
 * Used when an instruction contains multiple operations.
 */
export interface AmendmentOperation {
	/** The type of operation */
	type: "modification" | "insertion" | "deletion" | "matter_preceding";

	/** Target path for this specific operation */
	targetPath: HierarchyLevel[];

	/** For modifications: the before/after text segments */
	before?: TextSegment[];
	after?: TextSegment[];

	/** For insertions: the new text with position info */
	inserted?: TextSegment[];
	insertPosition?: "before" | "after" | "end" | "replace";

	/** For deletions: what was removed */
	deleted?: TextSegment[];

	/** For matter_preceding: the paragraph reference (e.g., "(2)") */
	precedingParagraph?: string;
}

/**
 * The computed effect of an amendatory instruction on a specific target.
 */
export interface AmendmentEffect {
	/** Reference to the original instruction */
	instructionIndex: number;

	/** The target path that was resolved */
	targetPath: HierarchyLevel[];

	/** The resolved node (null if not found) */
	targetNode: NodeRecord | null;

	/** The resolved content (null if not found) */
	targetContent: NodeContent | null;

	/** The type of effect */
	effectType:
		| "modification"
		| "insertion"
		| "deletion"
		| "full_replacement"
		| "multiple"
		| "matter_preceding"
		| "unknown";

	/** For modifications: the before/after text segments */
	before?: TextSegment[];
	after?: TextSegment[];

	/** For insertions: the new text with position info */
	inserted?: TextSegment[];
	insertPosition?: "before" | "after" | "end" | "replace";

	/** For deletions: what was removed */
	deleted?: TextSegment[];

	/** For multiple operations: the individual operations */
	operations?: AmendmentOperation[];

	/** Whether this effect involves edge cases we don't handle yet */
	hasEdgeCase: boolean;

	/** Description of the edge case if any */
	edgeCaseReason?: string;
}

/**
 * The result of computing effects for all instructions.
 */
export interface ComputedEffects {
	effects: AmendmentEffect[];
	sectionsNeeded: Map<string, NodeContent>;
}

// ============================================================================
// Effect Computation Engine
// ============================================================================

/**
 * Determines if an operation involves edge cases we don't handle yet.
 */
function detectEdgeCases(node: InstructionNode): {
	hasEdgeCase: boolean;
	reason?: string;
} {
	const text = node.text.toLowerCase();

	// Redesignation
	if (text.includes("redesignat")) {
		return { hasEdgeCase: true, reason: "Redesignation not yet supported" };
	}

	// Note: "matter preceding paragraph" is now handled as a special modification type

	// Cross-reference updates (these are simple text replacements, not edge cases)
	// We handle these as regular modifications

	// Check children for edge cases
	for (const child of node.children) {
		const childEdge = detectEdgeCases(child);
		if (childEdge.hasEdgeCase) {
			return childEdge;
		}
	}

	return { hasEdgeCase: false };
}

/**
 * Parses quoted text from an instruction into structured blocks.
 * Quoted text in amendatory instructions typically starts with "(a)" or similar labels.
 */
function parseQuotedText(quotedText: string): StatutoryBlock[] {
	const blocks: StatutoryBlock[] = [];
	const lines = quotedText.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Try to parse hierarchy label
		const labelMatch = trimmed.match(/^\(([^)]+)\)\s*(.*)$/);
		if (labelMatch) {
			const label = `(${labelMatch[1]})`;
			const content = labelMatch[2];
			const level = getLabelType(label);

			blocks.push({
				type: "content",
				label,
				content,
				level,
			});
		} else {
			// No label - could be continuation text
			blocks.push({
				type: "continuation",
				content: trimmed,
			});
		}
	}

	return blocks;
}

/**
 * Determines the hierarchy level type from a label string.
 */
function getLabelType(label: string): HierarchyLevel | undefined {
	// Remove parentheses
	const inner = label.slice(1, -1);

	// (a) - subsection (lowercase letter)
	if (/^[a-z]+$/.test(inner)) {
		return { type: "subsection", val: inner };
	}

	// (1) - paragraph (number)
	if (/^\d+$/.test(inner)) {
		return { type: "paragraph", val: inner };
	}

	// (A) - subparagraph (uppercase letter)
	if (/^[A-Z]+$/.test(inner)) {
		return { type: "subparagraph", val: inner };
	}

	// (i) - clause (lowercase roman numeral)
	if (/^[ivx]+$/.test(inner)) {
		return { type: "clause", val: inner };
	}

	// (I) - subclause (uppercase roman numeral)
	if (/^[IVX]+$/.test(inner)) {
		return { type: "subclause", val: inner };
	}

	return undefined;
}

/**
 * Computes the effect of a single instruction node.
 * This handles the non-edge cases: replace, delete, insert, add_at_end.
 */
function computeNodeEffect(
	node: InstructionNode,
	targetContent: NodeContent | null,
	_parentPath: HierarchyLevel[],
): {
	effectType: AmendmentEffect["effectType"];
	before?: TextSegment[];
	after?: TextSegment[];
	inserted?: TextSegment[];
	deleted?: TextSegment[];
	insertPosition?: AmendmentEffect["insertPosition"];
} {
	const op = node.operation;

	// If we don't have target content, we can't compute the effect
	if (!targetContent) {
		return { effectType: "unknown" };
	}

	switch (op.type) {
		case "replace": {
			// Replace: strike text and insert new text
			const before: TextSegment[] = [];
			const after: TextSegment[] = [];

			if (op.strikingContent) {
				before.push({
					text: op.strikingContent,
					type: "deleted",
				});
			}

			if (op.content) {
				after.push({
					text: op.content,
					type: "inserted",
				});
			}

			return { effectType: "modification", before, after };
		}

		case "delete": {
			// Delete: strike text
			const deleted: TextSegment[] = [];

			if (op.strikingContent) {
				deleted.push({
					text: op.strikingContent,
					type: "deleted",
				});
			}

			return { effectType: "deletion", deleted };
		}

		case "insert": {
			// Insert: add new text at a location
			const inserted: TextSegment[] = [];

			if (op.content) {
				inserted.push({
					text: op.content,
					type: "inserted",
				});
			}

			return { effectType: "insertion", inserted, insertPosition: "replace" };
		}

		case "insert_before": {
			const inserted: TextSegment[] = [];

			if (op.content) {
				inserted.push({
					text: op.content,
					type: "inserted",
				});
			}

			return { effectType: "insertion", inserted, insertPosition: "before" };
		}

		case "insert_after": {
			const inserted: TextSegment[] = [];

			if (op.content) {
				inserted.push({
					text: op.content,
					type: "inserted",
				});
			}

			return { effectType: "insertion", inserted, insertPosition: "after" };
		}

		case "add_at_end": {
			const inserted: TextSegment[] = [];

			if (op.content) {
				inserted.push({
					text: op.content,
					type: "inserted",
				});
			}

			return { effectType: "insertion", inserted, insertPosition: "end" };
		}

		default:
			return { effectType: "unknown" };
	}
}

/**
 * Computes the effect of an amendatory instruction.
 * This is the main entry point for effect computation.
 */
export function computeAmendmentEffect(
	instruction: AmendatoryInstruction,
	instructionIndex: number,
	sectionContent: NodeContent | null,
): AmendmentEffect {
	const targetPath = instruction.rootQuery;
	const tree = instruction.tree;

	// Check for edge cases
	const firstNode = tree[0];
	const edgeCase = firstNode
		? detectEdgeCases(firstNode)
		: { hasEdgeCase: false };

	// If we have edge cases, return early
	if (edgeCase.hasEdgeCase) {
		return {
			instructionIndex,
			targetPath,
			targetNode: null,
			targetContent: sectionContent,
			effectType: "unknown",
			hasEdgeCase: true,
			edgeCaseReason: edgeCase.reason,
		};
	}

	// For full section rewrites (common pattern: "to read as follows:")
	const instructionText = instruction.text.toLowerCase();
	if (instructionText.includes("to read as follows")) {
		// This is a full replacement - the quoted text contains the new section
		const quotedText = extractQuotedText(instruction);

		return {
			instructionIndex,
			targetPath,
			targetNode: null,
			targetContent: sectionContent,
			effectType: "full_replacement",
			before:
				sectionContent?.blocks.map((b) => ({
					text: b.content ?? "",
					type: "deleted" as const,
					hierarchyLabel: b.label,
				})) ?? [],
			after: parseQuotedText(quotedText).map((b) => ({
				text: b.content ?? "",
				type: "inserted" as const,
				hierarchyLabel: b.label,
			})),
			hasEdgeCase: false,
		};
	}

	// For single-operation instructions
	if (tree.length === 1 && tree[0]) {
		const node = tree[0];
		const nodeEffect = computeNodeEffect(node, sectionContent, targetPath);

		return {
			instructionIndex,
			targetPath,
			targetNode: null,
			targetContent: sectionContent,
			effectType: nodeEffect.effectType,
			before: nodeEffect.before,
			after: nodeEffect.after,
			inserted: nodeEffect.inserted,
			deleted: nodeEffect.deleted,
			insertPosition: nodeEffect.insertPosition,
			hasEdgeCase: false,
		};
	}

	// For multi-operation instructions, we need to process each child
	// Build a list of operations and return a "multiple" effect type
	const operations: AmendmentOperation[] = [];

	for (const childNode of tree) {
		const childEffect = computeNodeEffect(
			childNode,
			sectionContent,
			targetPath,
		);
		if (childEffect.effectType !== "unknown") {
			operations.push({
				type: childEffect.effectType as
					| "modification"
					| "insertion"
					| "deletion",
				targetPath: childNode.operation.target ?? targetPath,
				before: childEffect.before,
				after: childEffect.after,
				inserted: childEffect.inserted,
				insertPosition: childEffect.insertPosition,
				deleted: childEffect.deleted,
			});
		}
	}

	// If we have multiple operations, return a "multiple" effect
	if (operations.length > 1) {
		return {
			instructionIndex,
			targetPath,
			targetNode: null,
			targetContent: sectionContent,
			effectType: "multiple",
			operations,
			hasEdgeCase: false,
		};
	}

	// If we have exactly one operation, return it as a single effect
	if (operations.length === 1) {
		const op = operations[0];
		if (!op) {
			return {
				instructionIndex,
				targetPath,
				targetNode: null,
				targetContent: sectionContent,
				effectType: "unknown",
				hasEdgeCase: false,
			};
		}
		return {
			instructionIndex,
			targetPath: op.targetPath,
			targetNode: null,
			targetContent: sectionContent,
			effectType: op.type,
			before: op.before,
			after: op.after,
			inserted: op.inserted,
			deleted: op.deleted,
			insertPosition: op.insertPosition,
			hasEdgeCase: false,
		};
	}

	return {
		instructionIndex,
		targetPath,
		targetNode: null,
		targetContent: sectionContent,
		effectType: "unknown",
		hasEdgeCase: false,
	};
}

/**
 * Extracts quoted text from an instruction's paragraphs.
 * Quoted text typically starts with smart quotes and contains the new statutory language.
 */
function extractQuotedText(instruction: AmendatoryInstruction): string {
	const quotedParts: string[] = [];

	for (const para of instruction.paragraphs) {
		const text = para.text;
		// Check if this is quoted text (starts with left double quotation mark U+201C or regular quote)
		if (text.startsWith("\u201C") || text.startsWith('"')) {
			quotedParts.push(text);
		}
	}

	return quotedParts.join("\n");
}

/**
 * Computes effects for all amendatory instructions.
 * This is the main orchestrator function.
 */
export async function computeAllEffects(
	instructions: AmendatoryInstruction[],
	fetchSection: (path: HierarchyLevel[]) => Promise<NodeContent | null>,
): Promise<AmendmentEffect[]> {
	const effects: AmendmentEffect[] = [];

	for (let i = 0; i < instructions.length; i++) {
		const instruction = instructions[i];
		if (!instruction) continue;

		const targetPath = instruction.rootQuery;

		// Fetch the section content
		const sectionContent = await fetchSection(targetPath);

		// Compute the effect
		const effect = computeAmendmentEffect(instruction, i, sectionContent);
		effects.push(effect);
	}

	return effects;
}
