import type {
	FormattingSpan,
	OperationMatchAttempt,
	ResolutionIssue,
} from "../amendment-edit-engine-types";
import { renderMarkdown } from "../markdown";
import type {
	AmendmentApplySummary,
	AmendmentEffect,
	ApplyEditTreeArgs,
	ApplyFailureReasonKind,
	FailedApplyItem,
} from "./types";

// --- Apply summary / debug helpers ---

function mapIssueToFailureReason(
	issue: ResolutionIssue | undefined,
	outcome: Exclude<OperationMatchAttempt["outcome"], "applied">,
): {
	reasonKind: ApplyFailureReasonKind;
	reason: string;
	reasonDetail: string | null;
} {
	if (issue) {
		const hasCandidates =
			issue.candidateNodeIds !== undefined && issue.candidateNodeIds.length > 0;
		const detail = hasCandidates
			? `${issue.path} [candidates=${issue.candidateNodeIds?.join(", ")}]`
			: issue.path;
		switch (issue.kind) {
			case "target_ambiguous":
				return {
					reasonKind: "target_ambiguous",
					reason: "Target path was ambiguous.",
					reasonDetail: detail,
				};
			case "target_unresolved":
				return {
					reasonKind: "target_unresolved",
					reason: "Target path did not resolve.",
					reasonDetail: issue.path,
				};
			case "through_target_ambiguous":
				return {
					reasonKind: "through_target_ambiguous",
					reason: "Through-target path was ambiguous.",
					reasonDetail: detail,
				};
			case "through_target_unresolved":
				return {
					reasonKind: "through_target_unresolved",
					reason: "Through-target path did not resolve.",
					reasonDetail: issue.path,
				};
			case "anchor_target_ambiguous":
				return {
					reasonKind: "anchor_target_ambiguous",
					reason: "Anchor path was ambiguous.",
					reasonDetail: detail,
				};
			case "anchor_target_unresolved":
				return {
					reasonKind: "anchor_target_unresolved",
					reason: "Anchor path did not resolve.",
					reasonDetail: issue.path,
				};
			case "matter_preceding_target_ambiguous":
				return {
					reasonKind: "matter_preceding_target_ambiguous",
					reason: "Matter-preceding path was ambiguous.",
					reasonDetail: detail,
				};
			case "matter_preceding_target_unresolved":
				return {
					reasonKind: "matter_preceding_target_unresolved",
					reason: "Matter-preceding path did not resolve.",
					reasonDetail: issue.path,
				};
			case "matter_following_target_ambiguous":
				return {
					reasonKind: "matter_following_target_ambiguous",
					reason: "Matter-following path was ambiguous.",
					reasonDetail: detail,
				};
			case "matter_following_target_unresolved":
				return {
					reasonKind: "matter_following_target_unresolved",
					reason: "Matter-following path did not resolve.",
					reasonDetail: issue.path,
				};
			case "move_from_ambiguous":
				return {
					reasonKind: "move_from_ambiguous",
					reason: "Move source path was ambiguous.",
					reasonDetail: detail,
				};
			case "move_from_unresolved":
				return {
					reasonKind: "move_from_unresolved",
					reason: "Move source path did not resolve.",
					reasonDetail: issue.path,
				};
			case "move_anchor_ambiguous":
				return {
					reasonKind: "move_anchor_ambiguous",
					reason: "Move anchor path was ambiguous.",
					reasonDetail: detail,
				};
			case "move_anchor_unresolved":
				return {
					reasonKind: "move_anchor_unresolved",
					reason: "Move anchor path did not resolve.",
					reasonDetail: issue.path,
				};
		}
	}
	if (outcome === "scope_unresolved") {
		return {
			reasonKind: "scope_unresolved",
			reason: "Scope could not be resolved.",
			reasonDetail: null,
		};
	}
	return {
		reasonKind: "no_match",
		reason: "No matching text or anchor found in resolved scope.",
		reasonDetail: null,
	};
}

export function buildApplySummary(
	operationAttempts: OperationMatchAttempt[],
	resolutionIssues: ResolutionIssue[],
): AmendmentApplySummary {
	const issueByOperationIndex = new Map<number, ResolutionIssue>();
	for (const issue of resolutionIssues) {
		if (!issueByOperationIndex.has(issue.operationIndex)) {
			issueByOperationIndex.set(issue.operationIndex, issue);
		}
	}
	const failedItems: FailedApplyItem[] = [];
	for (
		let operationIndex = 0;
		operationIndex < operationAttempts.length;
		operationIndex += 1
	) {
		const attempt = operationAttempts[operationIndex];
		if (!attempt || attempt.outcome === "applied") continue;
		const failure = mapIssueToFailureReason(
			issueByOperationIndex.get(operationIndex),
			attempt.outcome,
		);
		failedItems.push({
			operationIndex,
			operationType: attempt.operationType,
			text: attempt.nodeText,
			originalText: attempt.originalNodeText ?? attempt.nodeText,
			scopeContextTexts: attempt.scopeContextTexts,
			outcome: attempt.outcome,
			targetPath: attempt.targetPath,
			reasonKind: failure.reasonKind,
			reason: failure.reason,
			reasonDetail: failure.reasonDetail,
			wasTranslated: attempt.wasTranslated,
			translatedInstructionText: attempt.translatedInstructionText,
		});
	}
	return {
		partiallyApplied: failedItems.length > 0,
		failedItems,
		wasTranslated: operationAttempts.some((a) => a.wasTranslated),
	};
}

export function makeUnsupportedResult(
	args: ApplyEditTreeArgs,
	renderModel: { plainText: string; spans: FormattingSpan[] },
	operationCount: number,
	operationAttempts: OperationMatchAttempt[],
	reason: string,
	pipeline?: {
		resolvedOperationCount: number;
		plannedPatchCount: number;
		resolutionIssues: ResolutionIssue[];
	},
): AmendmentEffect {
	const resolvedOperationCount = pipeline?.resolvedOperationCount ?? 0;
	const plannedPatchCount = pipeline?.plannedPatchCount ?? 0;
	const resolutionIssues = pipeline?.resolutionIssues ?? [];
	const applySummary = buildApplySummary(operationAttempts, resolutionIssues);
	return {
		status: "unsupported",
		sectionPath: args.sectionPath,
		renderModel,
		segments: [{ kind: "unchanged", text: args.sectionBody }],
		changes: [],
		deleted: [],
		inserted: [],
		annotatedHtml: args.renderAnnotatedHtml
			? renderMarkdown(args.sectionBody)
			: undefined,
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount,
			operationAttempts,
			failureReason: reason,
			pipeline: {
				resolvedOperationCount,
				plannedPatchCount,
				resolutionIssueCount: resolutionIssues.length,
				resolutionIssues,
			},
		},
	};
}
