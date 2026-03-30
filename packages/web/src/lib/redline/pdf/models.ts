import type { TranslationResult } from "../../amendment-ast-to-edit-tree";
import type { AmendmentEffect } from "../../amendment-edit-tree-apply";
import type { Paragraph } from "../../types";
import type { ParsedInstruction } from "../amendment-parser/handcrafted-instruction-parser";

export interface PageLayout {
	pageOffset: number;
	pageHeight: number;
	pageWidth: number;
}

export interface InstructionWorkflowDebug {
	sectionText: string;
	splitLines: string[];
	parsedInstruction: ParsedInstruction | null;
	translatedEditTree: TranslationResult | null;
}

export interface ParsedInstructionAnnotation {
	billSection: string | null;
	target: string;
	uscCitation: string | null;
	text: string;
	paragraphs: Paragraph[];
	startPage: number;
	endPage: number;
	targetScopePath: string;
}

export type PageItem =
	| {
			type: "paragraph";
			text: string;
			isBold: boolean;
			colorIndex: number | null;
			level: number | null;
			topPercent: number;
	  }
	| {
			type: "instruction";
			instruction: ParsedInstructionAnnotation;
			amendmentEffect: AmendmentEffect | null;
			sectionPath: string | null;
			workflowDebug: InstructionWorkflowDebug;
			colorIndex: number;
			topPercent: number;
	  };

export type InstructionPageItem = Extract<PageItem, { type: "instruction" }>;
