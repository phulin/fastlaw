import { buildCanonicalDocument } from "./amendment-document-model";
import { materializeRenderModelFromPatchBatches } from "./amendment-edit-canonical-update";
import {
	executeTreeSequential,
	type SequentialExecutionState,
} from "./amendment-edit-tree-apply/execute";
import {
	type TraversalContext,
	walkTree,
} from "./amendment-edit-tree-apply/resolve";
import {
	buildApplySummary,
	makeUnsupportedResult,
} from "./amendment-edit-tree-apply/summary";
import type {
	AmendmentEffect,
	ApplyEditTreeArgs,
} from "./amendment-edit-tree-apply/types";
import { renderMarkdown } from "./markdown";

export { walkTree };
export type {
	AmendmentApplySummary,
	AmendmentEffect,
	ApplyEditTreeArgs,
	ApplyFailureReasonKind,
	FailedApplyItem,
} from "./amendment-edit-tree-apply/types";

export function applyAmendmentEditTreeToSection(
	args: ApplyEditTreeArgs,
): AmendmentEffect {
	const initialModel =
		args.initialDocument ?? buildCanonicalDocument(args.sectionBody);
	const counter = { index: 0 };
	const execution: SequentialExecutionState = {
		document: initialModel,
		resolvedOperationCount: 0,
		patchBatches: [],
		attempts: [],
		issues: [],
		unsupportedReasons: [],
	};
	const traversalContext: TraversalContext = {
		target: [],
		scopeContextTexts: [],
		matterPreceding: null,
		matterPrecedingTarget: null,
		matterFollowingTarget: null,
		beforeInnerTarget: null,
		afterInnerTarget: null,
		unanchoredInsertMode: /\badding at the end\b/i.test(
			args.instructionText ?? "",
		)
			? "add_at_end"
			: "insert",
		sentenceOrdinal: null,
		atEndOnly: false,
		classificationOverrides: args.classificationOverrides,
		redesignations: new Map(),
	};
	executeTreeSequential(
		args.tree.children,
		traversalContext,
		counter,
		execution,
	);

	if (execution.resolvedOperationCount === 0) {
		return makeUnsupportedResult(
			args,
			{ plainText: initialModel.plainText, spans: initialModel.spans },
			0,
			[],
			execution.unsupportedReasons[0] ?? "no_edit_tree_operations",
			{ resolvedOperationCount: 0, plannedPatchCount: 0, resolutionIssues: [] },
		);
	}

	const patches = execution.patchBatches.flat();
	const attempts = execution.attempts;
	const renderModel = materializeRenderModelFromPatchBatches(
		initialModel,
		execution.patchBatches,
	);
	const workingText = renderModel.plainText;

	const changes = patches.map((patch) => ({
		deleted: patch.deletedPlain,
		inserted: `${patch.insertedPrefixPlain ?? ""}${patch.insertedPlain}${
			patch.insertedSuffixPlain ?? ""
		}`,
	}));
	const deleted = patches
		.map((patch) => patch.deletedPlain)
		.filter((value) => value.length > 0);
	const inserted = patches
		.map(
			(patch) =>
				`${patch.insertedPrefixPlain ?? ""}${patch.insertedPlain}${
					patch.insertedSuffixPlain ?? ""
				}`,
		)
		.filter((value) => value.length > 0);
	const applySummary = buildApplySummary(attempts, execution.issues);

	if (changes.length === 0) {
		return makeUnsupportedResult(
			args,
			{ plainText: initialModel.plainText, spans: initialModel.spans },
			execution.resolvedOperationCount,
			attempts,
			execution.unsupportedReasons[0] ??
				execution.issues[0]?.kind ??
				"no_patches_applied",
			{
				resolvedOperationCount: execution.resolvedOperationCount,
				plannedPatchCount: patches.length,
				resolutionIssues: execution.issues,
			},
		);
	}

	return {
		status: "ok",
		sectionPath: args.sectionPath,
		finalDocument: execution.document,
		renderModel,
		segments: [{ kind: "unchanged", text: workingText }],
		changes,
		deleted,
		inserted,
		annotatedHtml: args.renderAnnotatedHtml
			? renderMarkdown(workingText)
			: undefined,
		applySummary,
		debug: {
			sectionTextLength: args.sectionBody.length,
			operationCount: execution.resolvedOperationCount,
			operationAttempts: attempts,
			failureReason: null,
			pipeline: {
				resolvedOperationCount: execution.resolvedOperationCount,
				plannedPatchCount: patches.length,
				resolutionIssueCount: execution.issues.length,
				resolutionIssues: execution.issues,
			},
		},
	};
}
