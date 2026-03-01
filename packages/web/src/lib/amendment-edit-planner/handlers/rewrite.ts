import type {
	ClassificationOverride,
	OperationMatchAttempt,
	ResolvedInstructionOperation,
	ScopeRange,
} from "../../amendment-edit-engine-types";
import type { TextWithProvenance } from "../../amendment-edit-tree";

interface PushPatchArgs {
	start: number;
	end: number;
	deleted: string;
	inserted?: string;
	insertedPrefixPlain?: string;
	insertedSuffixPlain?: string;
	insertAt?: number;
}

interface RewriteHandlerArgs {
	operation: ResolvedInstructionOperation;
	range: ScopeRange | null;
	scopedText: string;
	plainText: string;
	attempt: OperationMatchAttempt;
	classificationOverrides?: ClassificationOverride[];
	pushPatch: (args: PushPatchArgs) => void;
	translateCrossReferences: (
		text: string,
		classificationOverrides?: ClassificationOverride[],
	) => string;
	formatReplacementContent: (
		content: TextWithProvenance,
		indent: number,
	) => TextWithProvenance;
	boundaryAwareReplacementSuffix: (
		inserted: TextWithProvenance,
		deleted: string,
		text: string,
		rangeEnd: number,
	) => string;
}

export function handleRewriteEdit(args: RewriteHandlerArgs): void {
	const {
		operation,
		range,
		scopedText,
		plainText,
		classificationOverrides,
		pushPatch,
		translateCrossReferences,
		formatReplacementContent,
		boundaryAwareReplacementSuffix,
	} = args;
	if (!range) return;
	if (operation.edit.kind !== "rewrite") return;

	let replacementContentText = operation.edit.content.text;
	replacementContentText = translateCrossReferences(
		replacementContentText,
		classificationOverrides,
	);
	const replacementContent = {
		...operation.edit.content,
		text: replacementContentText,
	};
	const formatted = formatReplacementContent(
		replacementContent,
		range.indent ?? 0,
	);
	pushPatch({
		start: range.start,
		end: range.end,
		deleted: scopedText,
		inserted: formatted.text,
		insertedSuffixPlain: boundaryAwareReplacementSuffix(
			formatted,
			scopedText,
			plainText,
			range.end,
		),
	});
}
