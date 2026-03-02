import type {
	CanonicalDocument,
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
	initialDocument?: CanonicalDocument;
	instructionText?: string;
	classificationOverrides?: ClassificationOverride[];
	renderAnnotatedHtml?: boolean;
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
	| "through_target_unresolved"
	| "through_target_ambiguous"
	| "anchor_target_unresolved"
	| "anchor_target_ambiguous"
	| "matter_preceding_target_unresolved"
	| "matter_preceding_target_ambiguous"
	| "matter_following_target_unresolved"
	| "matter_following_target_ambiguous"
	| "move_from_unresolved"
	| "move_from_ambiguous"
	| "move_anchor_unresolved"
	| "move_anchor_ambiguous"
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
