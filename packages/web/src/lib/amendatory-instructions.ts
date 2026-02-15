import type { Paragraph } from "./text-extract";

export type HierarchyLevel =
	| { type: "section"; val: string }
	| { type: "subsection"; val: string }
	| { type: "paragraph"; val: string }
	| { type: "subparagraph"; val: string }
	| { type: "clause"; val: string }
	| { type: "subclause"; val: string }
	| { type: "item"; val: string }
	| { type: "subitem"; val: string }
	| { type: "none" };

export type AmendmentActionType =
	| "replace"
	| "delete"
	| "insert"
	| "insert_before"
	| "insert_after"
	| "add_at_end"
	| "context"
	| "unknown";

export interface AmendatoryOperation {
	type: AmendmentActionType;
	target?: HierarchyLevel[]; // Relative path segments found in this text
	content?: string; // For 'insert', 'replace'
	strikingContent?: string; // The text being replaced
}

export interface InstructionNode {
	label?: HierarchyLevel; // The instruction level, e.g. (1)
	operation: AmendatoryOperation;
	children: InstructionNode[];
	text: string;
}

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
	/** Structured parsing of the target */
	rootQuery: HierarchyLevel[];
	/** Tree of specific operations */
	tree: InstructionNode[];
}

interface TreeNode {
	paragraph: Paragraph;
	children: TreeNode[];
	indent: number;
}

const SEC_HEADER_RE = /^SEC\.\s+(\d+)/;
const DIVISION_HEADER_RE =
	/^(?:TITLE|Subtitle|CHAPTER|SUBCHAPTER|PART|SEC\.)\s+[A-Z0-9]+[\s.—\u2014-]/i;
// Heuristic phrases that trigger an instruction block
const AMENDATORY_PHRASES = ["is amended", "is repealed", "is further amended"];
const USC_CITATION_RE =
	/(\d+)\s+U\.S\.C\.\s+\d+[A-Za-z0-9\u2013-]*(?:\([^)]*\))*/;
const USC_CITATION_SECTION_RE = /^\d+\s+U\.S\.C\.\s+([0-9A-Za-z-]+)/i;
const TITLE_SECTION_CITATION_RE =
	/section\s+(\d+(?:[A-Za-z0-9-]*)(?:\([^)]*\))*)\s+of\s+title\s+(\d+),?\s+United States Code/i;

function isQuotedText(text: string): boolean {
	return /^[""\u201c'']/.test(text.trimStart());
}

function getHierarchyLevel(text: string): HierarchyLevel {
	const trimmed = text.trim();
	if (SEC_HEADER_RE.test(trimmed)) {
		const match = trimmed.match(SEC_HEADER_RE);
		return { type: "section", val: match ? match[1] : "" };
	}

	// (i) Clause - Check BEFORE subsection to catch (i), (v), (x)
	const clauseMatch = trimmed.match(/^\(([ivx]+)\)/);
	if (clauseMatch) {
		return { type: "clause", val: clauseMatch[1] };
	}

	// (I) Subclause - distinct check
	const subclauseMatch = trimmed.match(/^\(([IVX]+)\)/);
	if (subclauseMatch) return { type: "subclause", val: subclauseMatch[1] };

	// (a) Subsection
	const subsectionMatch = trimmed.match(/^\(([a-z]+)\)/);
	if (subsectionMatch) return { type: "subsection", val: subsectionMatch[1] };

	// (1) Paragraph
	const paragraphMatch = trimmed.match(/^\((\d+)\)/);
	if (paragraphMatch) return { type: "paragraph", val: paragraphMatch[1] };

	// (A) Subparagraph
	const subparagraphMatch = trimmed.match(/^\(([A-Z]+)\)/);
	if (subparagraphMatch)
		return { type: "subparagraph", val: subparagraphMatch[1] };

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

function extractTargetString(text: string): string {
	// Match strictly on the phrase " is amended" etc to grab the prefix
	let splitIndex = -1;
	const lower = text.toLowerCase();

	for (const phrase of AMENDATORY_PHRASES) {
		const idx = lower.indexOf(phrase);
		if (idx !== -1) {
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
	if (match) return match[0];

	const titleSectionMatch = text.match(TITLE_SECTION_CITATION_RE);
	if (titleSectionMatch) {
		const section = titleSectionMatch[1];
		const title = titleSectionMatch[2];
		return `${title} U.S.C. ${section}`;
	}

	return null;
}

function getSectionLevelFromCitation(
	citation: string | null,
): HierarchyLevel | null {
	if (!citation) return null;
	const match = citation.match(USC_CITATION_SECTION_RE);
	if (!match) return null;
	return { type: "section", val: match[1] };
}

function hasSectionLevel(levels: HierarchyLevel[]): boolean {
	return levels.some((level) => level.type === "section");
}

/**
 * Strips the leading hierarchy label from a string.
 * e.g. "(1) in subsection (a)" -> "in subsection (a)"
 */
function stripInstructionLabel(text: string): string {
	const level = getHierarchyLevel(text);
	if (level.type === "none" || level.type === "section") return text;

	// Find the end of the label
	const closeParen = text.indexOf(")");
	if (closeParen !== -1) {
		return text.substring(closeParen + 1).trim();
	}
	return text;
}

function parseTarget(target: string): HierarchyLevel[] {
	const levels: HierarchyLevel[] = [];
	let current = target.replace(/^[A-Z][^\u2014]*\u2014\s*/, "").trim();

	while (true) {
		current = current.trim();
		if (current.length === 0) break;

		// consume common separators / noise words
		const noiseMatch = current.match(
			/^(?:in|of|and|the|by|striking|inserting|adding|redesignating|after|before|,|;)\s+/i,
		);
		if (noiseMatch) {
			current = current.substring(noiseMatch[0].length);
			continue;
		}

		const sectionMatch = current.match(/^section\s+(\w+)/i);
		if (sectionMatch) {
			levels.push({ type: "section", val: sectionMatch[1] });
			current = current.substring(sectionMatch[0].length);
			continue;
		}

		// Handle verbose types "subsection (a)", "paragraph (1)"
		const verboseMatch = current.match(
			/^(subsection|paragraph|subparagraph|clause|subclause|item)\s+\(([^)]+)\)/i,
		);
		if (verboseMatch) {
			const typeStr = verboseMatch[1].toLowerCase();
			const val = verboseMatch[2];

			// Map string to HierarchyLevel type
			let type: HierarchyLevel["type"] = "none";
			if (typeStr === "subsection") type = "subsection";
			else if (typeStr === "paragraph") type = "paragraph";
			else if (typeStr === "subparagraph") type = "subparagraph";
			else if (typeStr === "clause") type = "clause";
			else if (typeStr === "subclause") type = "subclause";
			else if (typeStr === "item") type = "item";

			if (type !== "none") {
				levels.push({ type, val } as HierarchyLevel);
			}
			current = current.substring(verboseMatch[0].length);
			continue;
		}

		// (i) - Clause (Prioritize over subsection to avoid confusion)
		const clauseMatch = current.match(/^\(([ivx]+)\)/);
		if (clauseMatch) {
			levels.push({ type: "clause", val: clauseMatch[1] });
			current = current.substring(clauseMatch[0].length);
			continue;
		}

		// (I) - Subclause
		const subclauseMatch = current.match(/^\(([IVX]+)\)/);
		if (subclauseMatch) {
			levels.push({ type: "subclause", val: subclauseMatch[1] });
			current = current.substring(subclauseMatch[0].length);
			continue;
		}

		const subMatch = current.match(/^\(([a-z]+)\)/);
		if (subMatch) {
			levels.push({ type: "subsection", val: subMatch[1] });
			current = current.substring(subMatch[0].length);
			continue;
		}

		const paraMatch = current.match(/^\((\d+)\)/);
		if (paraMatch) {
			levels.push({ type: "paragraph", val: paraMatch[1] });
			current = current.substring(paraMatch[0].length);
			continue;
		}

		const subParaMatch = current.match(/^\(([A-Z]+)\)/);
		if (subParaMatch) {
			levels.push({ type: "subparagraph", val: subParaMatch[1] });
			current = current.substring(subParaMatch[0].length);
			continue;
		}

		// If we hit something we don't recognize, we stop
		break;
	}

	const section = levels.find(
		(level): level is Extract<HierarchyLevel, { type: "section" }> =>
			level.type === "section",
	);
	if (!section) return levels;
	return [section, ...levels.filter((level) => level !== section)];
}

function extractFollowingContent(text: string): string | undefined {
	const marker = "the following:";
	const lower = text.toLowerCase();
	const markerIndex = lower.indexOf(marker);
	if (markerIndex === -1) return undefined;

	const raw = text.slice(markerIndex + marker.length).trim();
	if (raw.length === 0) return undefined;

	return raw
		.replace(/^[\s"“”'‘’]+/, "")
		.replace(/[\s"“”'‘’]+[.;,]*$/, "")
		.trim();
}

function extractStructuralStrikeTarget(text: string): HierarchyLevel[] {
	const strikeAndInsertMatch = text.match(
		/by striking\s+(.+?)\s+and\s+inserting\s+the following/i,
	);
	if (!strikeAndInsertMatch) return [];
	const structuralTarget = strikeAndInsertMatch[1]?.trim() ?? "";
	if (structuralTarget.length === 0) return [];
	return parseTarget(structuralTarget);
}

function parseOperation(text: string): AmendatoryOperation {
	const stripped = stripInstructionLabel(text);
	const lower = stripped.toLowerCase();
	let targetLevels = parseTarget(stripped);

	let type: AmendmentActionType = "unknown";
	let strikingContent: string | undefined;
	let content: string | undefined;

	// Extract quoted content for both striking and inserting
	// Match text between standard or smart quotes
	const strikingMatch = stripped.match(
		/striking\s+["\u201c‘']([^"\u201d’']+)/i,
	);
	if (strikingMatch) strikingContent = strikingMatch[1];

	const insertingMatch = stripped.match(
		/inserting\s+["\u201c‘']([^"\u201d’']+)/i,
	);
	if (insertingMatch) content = insertingMatch[1];
	const followingContent = extractFollowingContent(stripped);
	if (followingContent) {
		content = followingContent;
	}
	const structuralStrikeTarget = extractStructuralStrikeTarget(stripped);
	if (structuralStrikeTarget.length > 0) {
		for (const level of structuralStrikeTarget) {
			if (
				level.type !== "none" &&
				!targetLevels.some(
					(existing) =>
						existing.type === level.type && existing.val === level.val,
				)
			) {
				targetLevels = [...targetLevels, level];
			}
		}
	}

	if (
		lower.includes("by striking") ||
		lower.includes("is repealed") ||
		lower.includes("by inserting") ||
		lower.includes("by adding") ||
		lower.includes("by redesignating") ||
		lower.includes("is amended to read as follows") ||
		lower.includes("is further amended to read as follows")
	) {
		if (lower.includes("by striking") && lower.includes("inserting")) {
			type = "replace";
		} else if (
			lower.includes("is amended to read as follows") ||
			lower.includes("is further amended to read as follows")
		) {
			type = "replace";
		} else if (lower.includes("by striking") || lower.includes("is repealed")) {
			type = "delete";
		} else if (lower.includes("by inserting")) {
			if (lower.includes("before")) {
				type = "insert_before";
			} else if (lower.includes("after")) {
				type = "insert_after";
			} else {
				type = "insert";
			}
		} else if (lower.includes("by adding")) {
			type = "add_at_end";
		}

		return { type, target: targetLevels, content, strikingContent };
	}

	return { type: "context", target: targetLevels, content, strikingContent };
}

/**
 * Advanced tree builder that handles flattening and restructuring logic.
 * It consumes a flat list of nodes (lexical order) and reconstructs the hierarchy.
 */
function reconstructInstructionTree(nodes: TreeNode[]): InstructionNode[] {
	const result: InstructionNode[] = [];
	const stack: InstructionNode[] = [];

	for (const node of nodes) {
		const text = node.paragraph.text.trim();

		if (isQuotedText(text)) {
			// Attach to the last item on the stack (the active instruction)
			if (stack.length > 0) {
				const parent = stack[stack.length - 1];
				parent.children.push({
					label: { type: "none" },
					operation: { type: "unknown", content: text },
					children: [],
					text: text,
				});
			} else {
				// Floating quoted text? Should rarely happen if parsed correctly.
				// Treat as top level for now.
				result.push({
					label: { type: "none" },
					operation: { type: "unknown", content: text },
					children: [],
					text: text,
				});
			}
			continue;
		}

		const label = getHierarchyLevel(text);
		const rank = getHierarchyRank(label);

		// Pop from stack until we find a parent with lower rank (higher level)
		// e.g. if we are (A) [rank 3], we pop (i) [rank 4], we pop (B) [rank 3].
		// We stop when we see (1) [rank 2].
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const topRank = getHierarchyRank(top.label ?? { type: "none" });

			if (topRank !== -1 && rank !== -1 && topRank >= rank) {
				stack.pop();
			} else {
				break;
			}
		}

		const newNode: InstructionNode = {
			label: label.type !== "none" ? label : undefined,
			operation: parseOperation(text),
			children: [],
			text: text,
		};

		// If stack is empty, it's a root
		if (stack.length === 0) {
			result.push(newNode);
		} else {
			stack[stack.length - 1].children.push(newNode);
		}

		stack.push(newNode);
	}

	return result;
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
			if (indent > top.indent + 5) {
				top.children.push(node);
				stack.push(node);
				break;
			} else {
				stack.pop();
			}
		}

		if (stack.length === 0) {
			roots.push(node);
			stack.push(node);
		}
	}

	return roots;
}

export function extractAmendatoryInstructions(
	paragraphs: Paragraph[],
): AmendatoryInstruction[] {
	const instructions: AmendatoryInstruction[] = [];
	let currentBillSection: string | null = null;
	const lastSectionByBillSection = new Map<string | null, HierarchyLevel>();
	const lastCitationByBillSection = new Map<string | null, string>();

	const roots = buildTree(paragraphs);

	function traverse(nodes: TreeNode[]) {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const text = node.paragraph.text.trim();
			if (!text) continue;

			if (!isQuotedText(text) && SEC_HEADER_RE.test(text)) {
				currentBillSection = text;
			}

			const isInstruction =
				!isQuotedText(text) &&
				AMENDATORY_PHRASES.some((phrase) => text.includes(phrase));

			if (isInstruction) {
				const instructionLevel = getHierarchyLevel(text);
				const instructionRank = getHierarchyRank(instructionLevel);

				// The instruction node itself is always included
				const instructionParagraphs = [node.paragraph];

				// Flatten children and subsequent siblings into a linear list for reconstruction
				// We want to process them in reading order to rebuild the hierarchy based on labels
				const nodesToProcess: TreeNode[] = [];

				// Helper to add nodes while respecting division boundaries
				const addFilteredSubtree = (n: TreeNode, skipSelf: boolean = false) => {
					const t = n.paragraph.text.trim();
					if (
						!skipSelf &&
						(SEC_HEADER_RE.test(t) || DIVISION_HEADER_RE.test(t))
					) {
						return false; // Stop!
					}

					if (!skipSelf) {
						nodesToProcess.push(n);
						instructionParagraphs.push(n.paragraph);
					}

					for (const child of n.children) {
						if (!addFilteredSubtree(child)) break;
					}
					return true;
				};

				// Process current node's children
				for (const child of node.children) {
					addFilteredSubtree(child);
				}

				// Then consume siblings
				let j = i + 1;
				while (j < nodes.length) {
					const sibling = nodes[j];
					const siblingText = sibling.paragraph.text.trim();
					const siblingLevel = getHierarchyLevel(siblingText);
					const siblingRank = getHierarchyRank(siblingLevel);
					const siblingIsQuoted = isQuotedText(siblingText);

					if (
						!siblingIsQuoted &&
						siblingRank !== -1 &&
						siblingRank <= instructionRank &&
						instructionRank !== -1
					) {
						break;
					}

					if (
						SEC_HEADER_RE.test(siblingText) ||
						DIVISION_HEADER_RE.test(siblingText)
					) {
						break;
					}

					if (!addFilteredSubtree(sibling)) break;
					j++;
				}

				i = j - 1;

				const targetStr = extractTargetString(text);
				let rootQuery = parseTarget(targetStr);
				let uscCitation = extractUscCitation(text);
				const billSectionKey = currentBillSection;
				const usesSuchSection = /\bsuch section\b/i.test(targetStr);

				if (!uscCitation && usesSuchSection) {
					const priorCitation = lastCitationByBillSection.get(billSectionKey);
					if (priorCitation) {
						uscCitation = priorCitation;
					}
				}

				if (usesSuchSection && !hasSectionLevel(rootQuery)) {
					const priorSection = lastSectionByBillSection.get(billSectionKey);
					const citedSection = getSectionLevelFromCitation(uscCitation);
					const resolvedSection = priorSection ?? citedSection;
					if (resolvedSection) {
						rootQuery = [resolvedSection, ...rootQuery];
					}
				}

				const rootSection = rootQuery.find(
					(level): level is Extract<HierarchyLevel, { type: "section" }> =>
						level.type === "section",
				);
				if (rootSection) {
					lastSectionByBillSection.set(billSectionKey, rootSection);
				}
				if (uscCitation) {
					lastCitationByBillSection.set(billSectionKey, uscCitation);
				}

				// Reconstruct tree from the linear list of components
				// The instruction node itself is the 'root' context.
				const opTree = reconstructInstructionTree([node, ...nodesToProcess]);

				instructions.push({
					billSection: currentBillSection,
					target: targetStr,
					uscCitation,
					text: instructionParagraphs.map((p) => p.text).join("\n"),
					paragraphs: instructionParagraphs,
					startPage: instructionParagraphs[0].startPage,
					endPage:
						instructionParagraphs[instructionParagraphs.length - 1].endPage,
					rootQuery: rootQuery,
					tree: opTree,
				});
			} else {
				traverse(node.children);
			}
		}
	}

	traverse(roots);
	return instructions;
}
