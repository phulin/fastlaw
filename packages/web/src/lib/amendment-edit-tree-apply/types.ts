import type { ParsedMarkdownDocument } from "../amendment-document-model";
import type {
	ClassificationOverride,
	FormattingSpan,
	OperationMatchAttempt,
	ResolutionIssue,
} from "../amendment-edit-engine-types";
import type { InstructionSemanticTree } from "../amendment-edit-tree";

export interface ApplyEditTreeArgs {
	tree: InstructionSemanticTree;
	sectionPath: string;
	sectionBody: string;
	parsedDocument?: ParsedMarkdownDocument;
	instructionText?: string;
	classificationOverrides?: ClassificationOverride[];
}

export type AmendmentSegmentKind = "unchanged" | "deleted" | "inserted";

export interface AmendmentEffectSegment {
	kind: AmendmentSegmentKind;
	text: string;
}

export interface AmendmentEffectDebug {
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
	originalText: string;
	scopeContextTexts: string[];
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">;
	targetPath: string | null;
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
	wasTranslated: boolean;
	translatedInstructionText: string | null;
}

export interface AmendmentApplySummary {
	partiallyApplied: boolean;
	failedItems: FailedApplyItem[];
	wasTranslated: boolean;
}

export interface AmendmentEffect {
	status: "ok" | "unsupported";
	sectionPath: string;
	renderModel: {
		plainText: string;
		spans: FormattingSpan[];
	};
	segments: AmendmentEffectSegment[];
	changes: Array<{ deleted: string; inserted: string }>;
	deleted: string[];
	inserted: string[];
	annotatedHtml?: string;
	applySummary: AmendmentApplySummary;
	debug: AmendmentEffectDebug;
}
