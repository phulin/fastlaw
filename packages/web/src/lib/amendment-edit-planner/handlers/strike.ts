import { getScopeRangeFromNodeId } from "../../amendment-document-model";
import type {
	ClassificationOverride,
	DocumentModel,
	OperationMatchAttempt,
	ResolvedInstructionOperation,
	ScopeRange,
} from "../../amendment-edit-engine-types";
import type {
	EditTarget,
	InnerLocationTarget,
	PunctuationKind,
} from "../../amendment-edit-tree";

interface PushPatchArgs {
	start: number;
	end: number;
	deleted: string;
	inserted?: string;
	insertedPrefixPlain?: string;
	insertedSuffixPlain?: string;
	insertAt?: number;
}

interface StrikeHandlerArgs {
	model: DocumentModel;
	operation: ResolvedInstructionOperation;
	range: ScopeRange | null;
	scopedText: string;
	plainText: string;
	attempt: OperationMatchAttempt;
	classificationOverrides?: ClassificationOverride[];
	pushPatch: (args: PushPatchArgs) => void;
	textSearchFromEditTarget: (
		target: EditTarget,
	) => { text: string; eachPlaceItAppears?: boolean; atEnd?: boolean } | null;
	textFromEditTarget: (target: EditTarget) => string | null;
	punctuationText: (kind: PunctuationKind) => string;
	findPunctuationIndexAtEnd: (
		scopedText: string,
		kind: PunctuationKind,
	) => number;
	resolveInnerLocationRangeInScope: (
		model: DocumentModel,
		range: ScopeRange,
		target: InnerLocationTarget,
	) => ScopeRange | null;
	computeFallbackRegexSearch: (
		strikeText: string,
		classificationOverrides?: ClassificationOverride[],
	) => RegExp | null;
	findAllOccurrences: (haystack: string, needle: string) => number[];
	normalizeInlineDeletionRange: (
		text: string,
		start: number,
		end: number,
	) => { start: number; end: number };
}

export function handleStrikeEdit(args: StrikeHandlerArgs): void {
	const {
		model,
		operation,
		range,
		scopedText,
		plainText,
		attempt,
		classificationOverrides,
		pushPatch,
		textSearchFromEditTarget,
		textFromEditTarget,
		punctuationText,
		findPunctuationIndexAtEnd,
		resolveInnerLocationRangeInScope,
		computeFallbackRegexSearch,
		findAllOccurrences,
		normalizeInlineDeletionRange,
	} = args;
	if (!range) return;
	if (operation.edit.kind !== "strike") return;

	const strikeSearch = textSearchFromEditTarget(operation.edit.target);
	const strikingContent = strikeSearch?.text ?? null;
	const strikePunctuation =
		"punctuation" in operation.edit.target
			? operation.edit.target.punctuation
			: undefined;
	const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;
	const atEndSearch = strikeSearch?.atEnd === true;
	const throughContent = operation.edit.through
		? textFromEditTarget(operation.edit.through)
		: null;
	const throughPunctuation =
		operation.edit.through && "punctuation" in operation.edit.through
			? operation.edit.through.punctuation
			: undefined;

	if (!strikingContent && strikePunctuation && !throughContent) {
		const punctuation = punctuationText(strikePunctuation);
		const punctuationIndex = findPunctuationIndexAtEnd(
			scopedText,
			strikePunctuation,
		);
		attempt.searchText = punctuation;
		attempt.searchTextKind = "striking";
		attempt.searchIndex =
			punctuationIndex >= 0 ? range.start + punctuationIndex : null;
		if (punctuationIndex < 0) return;

		pushPatch({
			start: range.start + punctuationIndex,
			end: range.start + punctuationIndex + punctuation.length,
			deleted: punctuation,
		});
		return;
	}

	if (!strikingContent) {
		if ("inner" in operation.edit.target) {
			const innerRange = resolveInnerLocationRangeInScope(
				model,
				range,
				operation.edit.target.inner,
			);
			if (!innerRange) return;
			const deleted = plainText.slice(innerRange.start, innerRange.end);
			pushPatch({ start: innerRange.start, end: innerRange.end, deleted });
			return;
		}
		if (operation.structuralStrikeMode === "discrete") {
			if (operation.resolvedStructuralTargetIds.length === 0) return;
			if (operation.resolvedStructuralTargetIds.some((value) => value === null))
				return;
			const targetRanges = operation.resolvedStructuralTargetIds
				.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
				.filter((resolved): resolved is ScopeRange => resolved !== null);
			if (targetRanges.length !== operation.resolvedStructuralTargetIds.length)
				return;
			targetRanges
				.sort((left, right) => right.start - left.start)
				.forEach((targetRange) => {
					pushPatch({
						start: targetRange.start,
						end: targetRange.end,
						deleted: plainText.slice(targetRange.start, targetRange.end),
					});
				});
			return;
		}
		if (operation.resolvedThroughTargetId) {
			const throughRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedThroughTargetId,
			);
			if (!throughRange) return;
			const sameTargetLevel =
				throughRange.indent !== undefined &&
				range.indent !== undefined &&
				throughRange.indent === range.indent;
			if (!sameTargetLevel) {
				pushPatch({ start: range.start, end: range.end, deleted: scopedText });
				return;
			}
			const start = Math.min(range.start, throughRange.start);
			const end = Math.max(range.end, throughRange.end);
			pushPatch({ start, end, deleted: plainText.slice(start, end) });
			return;
		}
		pushPatch({ start: range.start, end: range.end, deleted: scopedText });
		return;
	}

	let localStart =
		operation.atEndOnly || atEndSearch
			? scopedText.lastIndexOf(strikingContent)
			: scopedText.indexOf(strikingContent);
	let resolvedStrikingContent = strikingContent;

	if (
		localStart < 0 &&
		strikingContent &&
		!throughContent &&
		!throughPunctuation
	) {
		const fallbackRegex = computeFallbackRegexSearch(
			strikingContent,
			classificationOverrides,
		);
		if (fallbackRegex) {
			const match = scopedText.match(fallbackRegex);
			if (match && match.index !== undefined && match.groups?.base) {
				localStart = match.index;
				resolvedStrikingContent = match[0];
				attempt.wasTranslated = true;
			}
		}
	}

	attempt.searchText = resolvedStrikingContent;
	attempt.searchTextKind = "striking";
	attempt.searchIndex = localStart >= 0 ? range.start + localStart : null;
	if (localStart < 0) return;

	if (eachPlaceItAppears && !throughContent && !throughPunctuation) {
		for (const occurrenceIndex of findAllOccurrences(
			scopedText,
			resolvedStrikingContent,
		)) {
			const patchRange = normalizeInlineDeletionRange(
				plainText,
				range.start + occurrenceIndex,
				range.start + occurrenceIndex + resolvedStrikingContent.length,
			);
			pushPatch({
				start: patchRange.start,
				end: patchRange.end,
				deleted: plainText.slice(patchRange.start, patchRange.end),
			});
		}
		return;
	}

	let localEnd = localStart + resolvedStrikingContent.length;
	if (throughContent) {
		const throughStart = scopedText.indexOf(
			throughContent,
			localStart + resolvedStrikingContent.length,
		);
		if (throughStart < 0) return;
		localEnd = throughStart + throughContent.length;
	}
	if (throughPunctuation) {
		const punctuation = punctuationText(throughPunctuation);
		const punctuationIndex = scopedText.indexOf(
			punctuation,
			localStart + resolvedStrikingContent.length,
		);
		if (punctuationIndex < 0) return;
		localEnd = punctuationIndex + punctuation.length;
	}

	let patchStart = range.start + localStart;
	let patchEnd = range.start + localEnd;
	if (throughContent || throughPunctuation) {
		const beforeChar = plainText[patchStart - 1] ?? "";
		const afterChar = plainText[patchEnd] ?? "";
		if (patchStart === 0 && afterChar === " ") {
			patchEnd += 1;
		} else if (patchStart > 0 && beforeChar === " " && afterChar === " ") {
			patchStart -= 1;
		}
	}
	const patchRange = normalizeInlineDeletionRange(
		plainText,
		patchStart,
		patchEnd,
	);
	pushPatch({
		start: patchRange.start,
		end: patchRange.end,
		deleted: plainText.slice(patchRange.start, patchRange.end),
	});
}
