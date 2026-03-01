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
		if (issue.kind.endsWith("_ambiguous")) {
			return {
				reasonKind: "target_ambiguous",
				reason: "Target path was ambiguous.",
				reasonDetail: hasCandidates
					? `${issue.path} [candidates=${issue.candidateNodeIds?.join(", ")}]`
					: issue.path,
			};
		}
		return {
			reasonKind: "target_unresolved",
			reason: "Target path did not resolve.",
			reasonDetail: issue.path,
		};
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
