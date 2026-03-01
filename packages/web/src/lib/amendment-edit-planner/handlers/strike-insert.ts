import { getScopeRangeFromNodeId } from "../../amendment-document-model";
import type {
	CanonicalDocument,
	ClassificationOverride,
	OperationMatchAttempt,
	ScopeRange,
} from "../../amendment-edit-engine-types";
import type { CanonicalPlanningOperation } from "../../amendment-edit-operation-adapter";
import type {
	EditTarget,
	InnerLocationTarget,
	PunctuationKind,
	TextWithProvenance,
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

interface StrikeInsertHandlerArgs {
	model: CanonicalDocument;
	operation: CanonicalPlanningOperation;
	range: ScopeRange | null;
	scopedText: string;
	plainText: string;
	attempt: OperationMatchAttempt;
	classificationOverrides?: ClassificationOverride[];
	pushPatch: (args: PushPatchArgs) => void;
	textSearchFromEditTarget: (
		target: EditTarget,
	) => { text: string; eachPlaceItAppears?: boolean; atEnd?: boolean } | null;
	translateCrossReferences: (
		text: string,
		classificationOverrides?: ClassificationOverride[],
	) => string;
	punctuationText: (kind: PunctuationKind) => string;
	findPunctuationIndexAtEnd: (
		scopedText: string,
		kind: PunctuationKind,
	) => number;
	resolveInnerLocationRangeInScope: (
		model: CanonicalDocument,
		range: ScopeRange,
		target: InnerLocationTarget,
	) => ScopeRange | null;
	formatStrikeInsertReplacementText: (args: {
		model: CanonicalDocument;
		content: TextWithProvenance;
		insertStart: number;
		fallbackIndent: number;
	}) => string;
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
	computeFallbackRegexSearch: (
		strikeText: string,
		classificationOverrides?: ClassificationOverride[],
	) => RegExp | null;
	findAllOccurrences: (haystack: string, needle: string) => number[];
}

export function handleStrikeInsertEdit(args: StrikeInsertHandlerArgs): void {
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
		translateCrossReferences,
		punctuationText,
		findPunctuationIndexAtEnd,
		resolveInnerLocationRangeInScope,
		formatStrikeInsertReplacementText,
		formatReplacementContent,
		boundaryAwareReplacementSuffix,
		computeFallbackRegexSearch,
		findAllOccurrences,
	} = args;
	if (!range) return;
	if (operation.edit.kind !== "strike_insert") return;

	const strikeSearch = textSearchFromEditTarget(operation.edit.strike);
	const strikingContent = strikeSearch?.text ?? null;
	const strikePunctuation =
		"punctuation" in operation.edit.strike
			? operation.edit.strike.punctuation
			: undefined;
	let replacementContentText = operation.edit.insert.text;
	replacementContentText = translateCrossReferences(
		replacementContentText,
		classificationOverrides,
	);

	const replacementContent = {
		...operation.edit.insert,
		text: replacementContentText,
	};
	const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;
	const atEndSearch = strikeSearch?.atEnd === true;

	if (!strikingContent && strikePunctuation) {
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
			inserted: replacementContent.text,
		});
		return;
	}

	if (!strikingContent) {
		if ("inner" in operation.edit.strike) {
			const innerRange = resolveInnerLocationRangeInScope(
				model,
				range,
				operation.edit.strike.inner,
			);
			if (!innerRange) return;
			const deleted = plainText.slice(innerRange.start, innerRange.end);
			const formattedReplacement = formatStrikeInsertReplacementText({
				model,
				content: replacementContent,
				insertStart: innerRange.start,
				fallbackIndent: range.indent ?? 0,
			});
			pushPatch({
				start: innerRange.start,
				end: innerRange.end,
				deleted,
				inserted: formattedReplacement,
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
				return;
			}
			const start = Math.min(range.start, throughRange.start);
			const end = Math.max(range.end, throughRange.end);
			const formatted = formatReplacementContent(
				replacementContent,
				range.indent ?? 0,
			);
			pushPatch({
				start,
				end,
				deleted: plainText.slice(start, end),
				inserted: formatted.text,
				insertedSuffixPlain: boundaryAwareReplacementSuffix(
					formatted,
					plainText.slice(start, end),
					plainText,
					end,
				),
			});
			return;
		}
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
		return;
	}

	let localIndex =
		operation.atEndOnly || atEndSearch
			? scopedText.lastIndexOf(strikingContent)
			: scopedText.indexOf(strikingContent);
	let resolvedStrikingContent = strikingContent;
	let resolvedReplacementContentText = replacementContent.text;

	if (localIndex < 0 && strikingContent) {
		const fallbackRegex = computeFallbackRegexSearch(
			strikingContent,
			classificationOverrides,
		);
		if (fallbackRegex) {
			const match = scopedText.match(fallbackRegex);
			if (match && match.index !== undefined && match.groups?.base) {
				localIndex = match.index;
				resolvedStrikingContent = match[0];
				attempt.wasTranslated = true;

				const originalPubLawBaseMatch =
					strikingContent.match(/section\s+([^()]+)/i);
				if (originalPubLawBaseMatch?.[1]) {
					const originalPubLawBase = originalPubLawBaseMatch[1];
					resolvedReplacementContentText = operation.edit.insert.text.replace(
						new RegExp(
							`section\\s+${originalPubLawBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
							"i",
						),
						`section ${match.groups.base}`,
					);
				}
			}
		}
	}

	attempt.searchText = resolvedStrikingContent;
	attempt.searchTextKind = "striking";
	attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
	if (localIndex < 0) return;

	const resolvedReplacementContent = {
		...replacementContent,
		text: resolvedReplacementContentText,
	};

	if (eachPlaceItAppears) {
		for (const occurrenceIndex of findAllOccurrences(
			scopedText,
			resolvedStrikingContent,
		)) {
			const patchStart = range.start + occurrenceIndex;
			const formattedReplacement = formatStrikeInsertReplacementText({
				model,
				content: resolvedReplacementContent,
				insertStart: patchStart,
				fallbackIndent: range.indent ?? 0,
			});
			pushPatch({
				start: patchStart,
				end: patchStart + resolvedStrikingContent.length,
				deleted: resolvedStrikingContent,
				inserted: formattedReplacement,
			});
		}
		return;
	}

	const patchStart = range.start + localIndex;
	const formattedReplacement = formatStrikeInsertReplacementText({
		model,
		content: resolvedReplacementContent,
		insertStart: patchStart,
		fallbackIndent: range.indent ?? 0,
	});
	pushPatch({
		start: patchStart,
		end: patchStart + resolvedStrikingContent.length,
		deleted: resolvedStrikingContent,
		inserted: formattedReplacement,
	});
}
