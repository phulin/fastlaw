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

const SEC_HEADER_RE = /^SEC\.\s+\d+/;
const IS_AMENDED_RE = /\bis\s+(further\s+)?amended\b/;
const STRUCTURAL_RE = /^(TITLE|SUBTITLE|CHAPTER|SUBCHAPTER|PART)\s+[IVXLC\d]/i;
const USC_CITATION_RE = /(\d+)\s+U\.S\.C\.\s+\d+(?:\([^)]*\))*/;

function isQuotedText(text: string): boolean {
	return /^[""\u201c'']/.test(text.trimStart());
}

/** Standalone subsection header like "(b) CONFORMING AMENDMENTS.\u2014" */
function isSubsectionHeader(text: string): boolean {
	const t = text.trim();
	return /^\([a-z]+\)\s+[A-Z]/i.test(t) && t.endsWith("\u2014");
}

function extractTarget(text: string): string {
	const match = text.match(/^(.*?)\s+is\s+amended\b/i);
	if (!match) return "";
	let target = match[1].trim();
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

export function extractAmendatoryInstructions(
	paragraphs: Paragraph[],
): AmendatoryInstruction[] {
	const instructions: AmendatoryInstruction[] = [];
	let billSection: string | null = null;

	let pending: {
		target: string;
		uscCitation: string | null;
		paragraphs: Paragraph[];
		billSection: string | null;
	} | null = null;

	const flush = () => {
		if (!pending) return;
		const paras = pending.paragraphs;
		instructions.push({
			billSection: pending.billSection,
			target: pending.target,
			uscCitation: pending.uscCitation,
			text: paras.map((p) => p.text).join("\n"),
			paragraphs: paras,
			startPage: paras[0].startPage,
			endPage: paras[paras.length - 1].endPage,
		});
		pending = null;
	};

	for (const paragraph of paragraphs) {
		const text = paragraph.text.trim();
		if (!text) continue;

		const quoted = isQuotedText(text);

		// Bill section headers (SEC. 10101. ...)
		if (!quoted && SEC_HEADER_RE.test(text)) {
			flush();
			billSection = text;
			continue;
		}

		// Structural headers (TITLE, SUBTITLE, CHAPTER, etc.)
		if (!quoted && STRUCTURAL_RE.test(text)) {
			flush();
			continue;
		}

		// "is amended" starts a new instruction
		if (!quoted && IS_AMENDED_RE.test(text)) {
			flush();
			pending = {
				target: extractTarget(text),
				uscCitation: extractUscCitation(text),
				paragraphs: [paragraph],
				billSection,
			};
			continue;
		}

		// Standalone subsection headers flush but aren't part of any instruction
		if (!quoted && isSubsectionHeader(text)) {
			flush();
			continue;
		}

		// Append to current instruction
		if (pending) {
			pending.paragraphs.push(paragraph);
		}
	}

	flush();
	return instructions;
}
