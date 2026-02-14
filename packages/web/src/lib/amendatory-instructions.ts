import type { Paragraph } from "./text-extract";

export interface AmendatoryInstruction {
	/** Bill section header (e.g., "SEC. 10101. RE-EVALUATION OF THRIFTY FOOD PLAN.") */
	billSection: string | null;
	/** The statutory target being amended (e.g., "Section 3 of the Food and Nutrition Act of 2008 (7 U.S.C. 2012)") */
	target: string;
	/** Extracted USC citation if present (e.g., "7 U.S.C. 2012") */
	uscCitation: string | null;
	/** Combined text of all paragraphs in this instruction */
	text: string;
	/** Source paragraphs */
	paragraphs: Paragraph[];
	startPage: number;
	endPage: number;
}

interface TreeNode {
	paragraph: Paragraph;
	children: TreeNode[];
	indent: number;
}

const SEC_HEADER_RE = /^SEC\.\s+\d+/;
// Heuristic phrases that trigger an instruction block
const AMENDATORY_PHRASES = ["is amended", "is repealed", "is further amended"];
const USC_CITATION_RE = /(\d+)\s+U\.S\.C\.\s+\d+(?:\([^)]*\))*/;

function isQuotedText(text: string): boolean {
	return /^[""\u201c'']/.test(text.trimStart());
}

type HierarchyLevel =
	| { type: "section"; val: number }
	| { type: "subsection"; val: string }
	| { type: "paragraph"; val: number }
	| { type: "subparagraph"; val: string }
	| { type: "clause"; val: string }
	| { type: "subclause"; val: string }
	| { type: "none" };

function getHierarchyLevel(text: string): HierarchyLevel {
	const trimmed = text.trim();
	if (SEC_HEADER_RE.test(trimmed)) return { type: "section", val: 0 }; // Value doesn't really matter for sections in this context

	// (a) Subsection
	const subsectionMatch = trimmed.match(/^\(([a-z]+)\)/);
	if (subsectionMatch) return { type: "subsection", val: subsectionMatch[1] };

	// (1) Paragraph
	const paragraphMatch = trimmed.match(/^\((\d+)\)/);
	if (paragraphMatch)
		return { type: "paragraph", val: parseInt(paragraphMatch[1], 10) };

	// (A) Subparagraph
	const subparagraphMatch = trimmed.match(/^\(([A-Z]+)\)/);
	if (subparagraphMatch)
		return { type: "subparagraph", val: subparagraphMatch[1] };

	// (i) Clause
	const clauseMatch = trimmed.match(/^\(([ivx]+)\)/i); // Simplified roman numeral check
	if (clauseMatch && /^[ivx]+$/.test(clauseMatch[1]))
		return { type: "clause", val: clauseMatch[1] };

	// (I) Subclause - distinct from subparagraph by context usually, but for simple heuristic:
	// This is tricky because (I) matches (A) regex too.
	// In standard legislative drafting: (a)(1)(A)(i)(I).
	// Let's assume (A) is subparagraph and (I) is subclause if we are already deep.
	// For now, let's treat generic (Letter) as Subparagraph level, and handle strictly if needed.
	// Actually, (I) is often subclause.

	// Let's stick to a simple numerical rank for comparison:
	// Section: 0
	// Subsection (a): 1
	// Paragraph (1): 2
	// Subparagraph (A): 3
	// Clause (i): 4
	// Subclause (I): 5

	return { type: "none" };
}

function getHierarchyRank(level: HierarchyLevel): number {
	switch (level.type) {
		case "section":
			return 0;
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
		default:
			return -1;
	}
}

function extractTarget(text: string): string {
	// Match strictly on the phrase " is amended" etc to grab the prefix
	// We iterate phrases to find the earliest match
	let splitIndex = -1;

	const lower = text.toLowerCase();

	for (const phrase of AMENDATORY_PHRASES) {
		const idx = lower.indexOf(phrase);
		if (idx !== -1) {
			// Pick the earliest occurrence
			if (splitIndex === -1 || idx < splitIndex) {
				splitIndex = idx;
			}
		}
	}

	if (splitIndex === -1) return "";

	let target = text.substring(0, splitIndex).trim();

	// Strip leading subsection labels: (a), (b)(1), etc.
	target = target.replace(/^(?:\([a-zA-Z0-9]+\)\s*)+/, "");
	// Strip uppercase header before em-dash: "IN GENERAL.\u2014", "EXCEPTIONS.\u2014"
	target = target.replace(/^[A-Z][^\u2014]*\u2014\s*/, "");
	return target.trim();
}

function extractUscCitation(text: string): string | null {
	const match = text.match(USC_CITATION_RE);
	return match ? match[0] : null;
}

/**
 * Builds a tree of paragraphs based on their visual indentation (xStart).
 */
function buildTree(paragraphs: Paragraph[]): TreeNode[] {
	const roots: TreeNode[] = [];
	const stack: TreeNode[] = [];

	for (const p of paragraphs) {
		const indent = p.lines[0]?.xStart ?? 0;
		const node: TreeNode = { paragraph: p, children: [], indent };

		// Unwind stack to find the correct parent
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			// If new node is indented to the right of top (with some tolerance), it is a child
			// Tolerance of ~5 units handles minor alignment jitters
			if (indent > top.indent + 5) {
				top.children.push(node);
				// This node becomes the new top of stack for subsequent deeper children
				stack.push(node);
				break;
			} else {
				// Not a child of 'top', so we are done with 'top's subtree (for now)
				stack.pop();
			}
		}

		// If stack is empty, this is a root node (at the current level of traversal)
		if (stack.length === 0) {
			roots.push(node);
			stack.push(node);
		}
	}

	return roots;
}

/**
 * flattens a subtree into a list of paragraphs
 */
function flattenSubtree(node: TreeNode): Paragraph[] {
	const result = [node.paragraph];
	for (const child of node.children) {
		result.push(...flattenSubtree(child));
	}
	return result;
}

export function extractAmendatoryInstructions(
	paragraphs: Paragraph[],
): AmendatoryInstruction[] {
	const instructions: AmendatoryInstruction[] = [];
	// Global tracker for the most recent Bill Section encountered
	let currentBillSection: string | null = null;

	const roots = buildTree(paragraphs);

	// Recursive traversal
	function traverse(nodes: TreeNode[]) {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const text = node.paragraph.text.trim();
			if (!text) continue;

			// Update Bill Section context if this paragraph looks like one
			// (and it's not quoted text)
			if (!isQuotedText(text) && SEC_HEADER_RE.test(text)) {
				currentBillSection = text;
				// A bill section header itself *might* contain an instruction inline
				// e.g. "SEC. 101. SECTION 5 IS AMENDED..."
				// so we fall through to check amendatory phrases
			}

			// Check for amendatory phrase
			const isInstruction =
				!isQuotedText(text) &&
				AMENDATORY_PHRASES.some((phrase) => text.includes(phrase));

			if (isInstruction) {
				// This node is the root of an instruction.
				const instructionLevel = getHierarchyLevel(text);
				const instructionRank = getHierarchyRank(instructionLevel);

				// Start with this node's subtree
				const instructionParagraphs = flattenSubtree(node);

				// Look ahead at subsequent siblings
				// We consume siblings if they are:
				// 1. Quoted text (content of amendment)
				// 2. Deeper in hierarchy than the instruction
				// 3. "continuation" text that doesn't look like a new structure (e.g. "and")
				let j = i + 1;
				while (j < nodes.length) {
					const sibling = nodes[j];
					const siblingText = sibling.paragraph.text.trim();
					const siblingLevel = getHierarchyLevel(siblingText);
					const siblingRank = getHierarchyRank(siblingLevel);

					const siblingIsQuoted = isQuotedText(siblingText);

					// Stop if:
					// 1. Sibling is a known structure AT or ABOVE our level (e.g. we are at (1), sibling is (2) or (b))
					//    AND it is NOT quoted text.
					if (
						!siblingIsQuoted &&
						siblingRank !== -1 &&
						siblingRank <= instructionRank &&
						instructionRank !== -1
					) {
						break;
					}

					// Specific case: if we are at (a) [rank 1], and sibling is (1) [rank 2], we consume it.
					// If sibling is (b) [rank 1], we break.

					// If sibling has no discernible hierarchy (rank -1) and is not quoted:
					// It might be continuation text "and" or "or". We generally consume it.
					// But if it looks like a new Section "SEC. 102", we break.
					if (SEC_HEADER_RE.test(siblingText)) {
						break;
					}

					// Otherwise, consume this sibling
					instructionParagraphs.push(...flattenSubtree(sibling));
					j++;
				}

				// Advance main loop index to skip consumed siblings
				i = j - 1;

				instructions.push({
					billSection: currentBillSection,
					target: extractTarget(text),
					uscCitation: extractUscCitation(text),
					text: instructionParagraphs.map((p) => p.text).join("\n"),
					paragraphs: instructionParagraphs,
					startPage: instructionParagraphs[0].startPage,
					endPage:
						instructionParagraphs[instructionParagraphs.length - 1].endPage,
				});

				// Do NOT recurse into children of the instruction node itself; they are consumed.
			} else {
				// Not an instruction itself; it might be a structural header (parent)
				// or just non-amendatory text.
				// Recurse to see if children trigger instructions.
				traverse(node.children);
			}
		}
	}

	traverse(roots);
	return instructions;
}
