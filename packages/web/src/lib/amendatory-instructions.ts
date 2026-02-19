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
	| "redesignate"
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
const TITLE_SECTION_CITATION_RE =
	/section\s+(\d+(?:[A-Za-z0-9-]*)(?:\([^)]*\))*)\s+of\s+title\s+(\d+),?\s+United States Code/i;

function isQuotedText(text: string): boolean {
	return /^[""\u201c'']/.test(text.trimStart());
}

function getHierarchyLevel(
	text: string,
	_options?: { indentationHint?: number },
): HierarchyLevel {
	const trimmed = text.trim();
	if (SEC_HEADER_RE.test(trimmed)) {
		const match = trimmed.match(SEC_HEADER_RE);
		return { type: "section", val: match ? match[1] : "" };
	}

	const clauseMatch = trimmed.match(/^\(([ivx]+)\)/);
	if (clauseMatch) {
		return { type: "clause", val: clauseMatch[1] };
	}

	const subclauseMatch = trimmed.match(/^\(([IVX]+)\)/);
	if (subclauseMatch) {
		return { type: "subclause", val: subclauseMatch[1] };
	}

	const subsectionMatch = trimmed.match(/^\(([a-z]+)\)/);
	if (subsectionMatch) {
		return { type: "subsection", val: subsectionMatch[1] };
	}

	const paragraphMatch = trimmed.match(/^\((\d+)\)/);
	if (paragraphMatch) {
		return { type: "paragraph", val: paragraphMatch[1] };
	}

	const subparagraphMatch = trimmed.match(/^\(([A-Z]+)\)/);
	if (subparagraphMatch) {
		return { type: "subparagraph", val: subparagraphMatch[1] };
	}

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
	// Strip uppercase header before em-dash: "IN GENERAL.—", "EXCEPTIONS.—"
	// We specifically look for the period-dash combo to avoid consuming citations with en-dashes
	target = target.replace(/^[A-Z\s]{4,}[^\u2014]*\.\u2014\s*/, "");
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
			/^(?:in|of|and|the|by|striking|inserting|adding|redesignating|after|before|is amended|is repealed|is further amended|Act|,|;|—|-|:)\s+/i,
		);
		if (noiseMatch) {
			current = current.substring(noiseMatch[0].length);
			continue;
		}

		// Skip parenthetical editorial qualifiers like "(as so redesignated)".
		// These are not hierarchy markers and would otherwise stop parsing.
		const qualifierMatch = current.match(/^\(([^)]+)\)/);
		if (
			qualifierMatch?.[1] &&
			(/\s/.test(qualifierMatch[1]) ||
				/\b(?:as|added|amended|redesignated|inserted)\b/i.test(
					qualifierMatch[1],
				))
		) {
			current = current.substring(qualifierMatch[0].length);
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
			/^(subsection|paragraph|subparagraph|clause|subclause|item)s?\s+\(([^)]+)\)/i,
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
		/striking\s+["\u201c\u201d\u201e\u201f‘']([^"\u201d’']+)/i,
	);
	if (strikingMatch) strikingContent = strikingMatch[1];

	const insertingMatch = stripped.match(
		/inserting\s+["\u201c\u201d\u201e\u201f‘']([^"\u201d’']+)/i,
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
		} else if (lower.includes("by redesignating")) {
			type = "redesignate";
		}

		return { type, target: targetLevels, content, strikingContent };
	}

	return { type: "context", target: targetLevels, content, strikingContent };
}

function extractTrailingStructuralStrikeTarget(text: string): HierarchyLevel[] {
	const trailingStrikeMatch = text.match(/by striking\s+(.+?)\s*(?:and)?\s*$/i);
	if (!trailingStrikeMatch) return [];
	const structuralTarget = trailingStrikeMatch[1]?.trim() ?? "";
	if (structuralTarget.length === 0) return [];
	return parseTarget(structuralTarget);
}

function mergeUniqueTargets(
	base: HierarchyLevel[] | undefined,
	extra: HierarchyLevel[],
): HierarchyLevel[] {
	const merged = [...(base ?? [])];
	for (const level of extra) {
		if (
			level.type !== "none" &&
			!merged.some(
				(existing) =>
					existing.type === level.type && existing.val === level.val,
			)
		) {
			merged.push(level);
		}
	}
	return merged;
}

function normalizeSplitStrikeAndInsert(nodes: InstructionNode[]): void {
	for (const node of nodes) {
		normalizeSplitStrikeAndInsert(node.children);

		if (node.operation.type !== "delete" || node.operation.strikingContent) {
			continue;
		}
		if (!/\bby striking\b/i.test(node.text)) continue;

		const insertionChild = node.children.find((child) =>
			/^\s*(?:\([A-Za-z0-9]+\)\s*)*inserting\s+the following\b/i.test(
				child.text,
			),
		);
		if (!insertionChild || !insertionChild.operation.content) continue;

		node.operation.type = "replace";
		node.operation.content = insertionChild.operation.content;
		node.operation.target = mergeUniqueTargets(
			node.operation.target,
			extractTrailingStructuralStrikeTarget(node.text),
		);
	}
}

/**
 * Advanced tree builder that handles flattening and restructuring logic.
 * It consumes a flat list of nodes (lexical order) and reconstructs the hierarchy.
 */
function reconstructInstructionTree(nodes: TreeNode[]): InstructionNode[] {
	const result: InstructionNode[] = [];
	const stack: InstructionNode[] = [];
	let activeSplitRecipients: InstructionNode[] = [];

	const getDeepestTarget = (
		node: InstructionNode,
	): Exclude<HierarchyLevel, { type: "none" }> | null => {
		const target = node.operation.target;
		if (!target || target.length === 0) return null;
		for (let i = target.length - 1; i >= 0; i--) {
			const level = target[i];
			if (level && level.type !== "none") {
				return level;
			}
		}
		return null;
	};

	const getQuotedLeadingMarker = (text: string): string | null => {
		const normalized = text.trimStart().replace(/^[""\u201c\u201d'']+/, "");
		const match = normalized.match(/^\(([A-Za-z0-9]+)\)/);
		return match?.[1] ?? null;
	};

	for (const node of nodes) {
		const text = node.paragraph.text.trim();

		if (isQuotedText(text)) {
			const marker = getQuotedLeadingMarker(text);
			if (marker && activeSplitRecipients.length > 0) {
				const matchingRecipient = activeSplitRecipients.find((recipient) => {
					const deepestTarget = getDeepestTarget(recipient);
					return deepestTarget?.val === marker;
				});
				if (matchingRecipient) {
					matchingRecipient.children.push({
						label: { type: "none" },
						operation: { type: "unknown", content: text },
						children: [],
						text: text,
					});
					continue;
				}
			}

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

		const label = getHierarchyLevel(text, { indentationHint: node.indent });
		const rank = getHierarchyRank(label);
		activeSplitRecipients = [];

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

		const operation = parseOperation(text);
		const targets = operation.target ?? [];

		// Detect plural targets like "subparagraphs (A) and (B)"
		// We look for multiple levels of the SAME rank.
		const rankCounts: Record<number, number> = {};
		for (const t of targets) {
			const r = getHierarchyRank(t);
			rankCounts[r] = (rankCounts[r] || 0) + 1;
		}
		const pluralRank = Object.keys(rankCounts).find(
			(r) => rankCounts[Number(r)] > 1,
		);

		const nodesToPush: InstructionNode[] = [];
		const shouldSplit = [
			"replace",
			"delete",
			"insert",
			"insert_before",
			"insert_after",
			"add_at_end",
		].includes(operation.type);

		if (pluralRank !== undefined && shouldSplit) {
			const rank = Number(pluralRank);
			const sameRankTargets = targets.filter(
				(t) => getHierarchyRank(t) === rank,
			);
			const commonPath = targets.filter((t) => getHierarchyRank(t) < rank);

			for (const target of sameRankTargets) {
				nodesToPush.push({
					label: label.type !== "none" ? label : undefined,
					operation: { ...operation, target: [...commonPath, target] },
					children: [],
					text: text,
				});
			}
			if (
				operation.type === "replace" &&
				/\binserting the following\b/i.test(text)
			) {
				activeSplitRecipients = [...nodesToPush];
			}
		} else {
			nodesToPush.push({
				label: label.type !== "none" ? label : undefined,
				operation,
				children: [],
				text: text,
			});
		}

		for (let i = 0; i < nodesToPush.length; i++) {
			const newNode = nodesToPush[i];
			if (stack.length === 0) {
				result.push(newNode);
			} else {
				stack[stack.length - 1].children.push(newNode);
			}

			// Only the last one (or single one) becomes the active parent for potential children
			if (i === nodesToPush.length - 1) {
				stack.push(newNode);
			}
		}
	}

	normalizeSplitStrikeAndInsert(result);
	return result;
}

/**
 * Splits a paragraph into multiple virtual paragraphs if it contains multiple instructions.
 * e.g. "(1) by ...; and (2) by ..."
 */
function splitCombinedParagraphs(p: Paragraph): Paragraph[] {
	if (isQuotedText(p.text)) return [p];

	const parts: Paragraph[] = [];
	let currentText = p.text;

	// Split after "is amended—" or similar if followed by a marker like (1)
	const amendatoryHeaderMatch = currentText.match(
		/^(.*(?:is amended|is repealed|is further amended)[\u2014\u2013:-])\s+(\(\d+\)|\([a-z]\)|\([A-Z]\))/i,
	);

	if (amendatoryHeaderMatch) {
		parts.push({ ...p, text: amendatoryHeaderMatch[1].trim() });
		currentText = currentText.substring(amendatoryHeaderMatch[1].length).trim();
	}

	// Now look for internal segments like "; (2) ", "; and (B) ", ". (ii) "
	// We use a regex that matches the separator and the label.
	const segmentRegex =
		/([;.]\s+(?:and\s+)?)(?=\(\d+\)|\([a-z]\)|\([A-Z]\)|\([ivx]+\))/gi;

	let lastIndex = 0;
	for (const match of currentText.matchAll(segmentRegex)) {
		const segment = currentText.substring(lastIndex, match.index).trim();
		if (segment) {
			parts.push({ ...p, text: segment });
		}
		lastIndex = match.index + match[1].length;
	}

	const remaining = currentText.substring(lastIndex).trim();
	if (remaining) {
		parts.push({ ...p, text: remaining });
	}

	return parts.length > 0 ? parts : [p];
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
		const text = p.text.trim();

		if (isQuotedText(text) && stack.length > 0) {
			stack[stack.length - 1].children.push(node);
			stack.push(node);
			continue;
		}

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
				const instructionLevel = getHierarchyLevel(text, {
					indentationHint: node.indent,
				});
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
					const siblingLevel = getHierarchyLevel(siblingText, {
						indentationHint: sibling.indent,
					});
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
				let uscCitation = extractUscCitation(text);
				const billSectionKey = currentBillSection;
				const usesSuchSection = /\bsuch section\b/i.test(targetStr);

				if (!uscCitation && usesSuchSection) {
					const priorCitation = lastCitationByBillSection.get(billSectionKey);
					if (priorCitation) {
						uscCitation = priorCitation;
					}
				}

				if (uscCitation) {
					lastCitationByBillSection.set(billSectionKey, uscCitation);
				}

				// Reconstruct tree from the linear list of components
				// The instruction node itself is the 'root' context.
				const flattenedNodes: TreeNode[] = [];
				for (const n of [node, ...nodesToProcess]) {
					const split = splitCombinedParagraphs(n.paragraph);
					for (const sp of split) {
						flattenedNodes.push({
							paragraph: sp,
							children: [],
							indent: n.indent,
						});
					}
				}

				const opTree = reconstructInstructionTree(flattenedNodes);
				const rootTextCounts = new Map<string, number>();
				for (const opNode of opTree) {
					rootTextCounts.set(
						opNode.text,
						(rootTextCounts.get(opNode.text) ?? 0) + 1,
					);
				}
				const hasSplitSiblings = Array.from(rootTextCounts.values()).some(
					(count) => count > 1,
				);
				if (hasSplitSiblings) {
					for (const opNode of opTree) {
						for (const child of opNode.children) {
							if (!isQuotedText(child.text)) continue;
							const sourceParagraph = instructionParagraphs.find(
								(paragraph) => paragraph.text.trim() === child.text.trim(),
							);
							if (sourceParagraph) {
								instructionParagraphs.push(sourceParagraph);
							}
						}
					}
				}

				instructions.push({
					billSection: currentBillSection,
					target: targetStr,
					uscCitation,
					text: instructionParagraphs.map((p) => p.text).join("\n"),
					paragraphs: instructionParagraphs,
					startPage: instructionParagraphs[0].startPage,
					endPage:
						instructionParagraphs[instructionParagraphs.length - 1].endPage,
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
