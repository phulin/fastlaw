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
	textFromEditTarget: (target: EditTarget) => string | null;
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
	findAnchorSearchMatch: (
		haystack: string,
		needle: string,
		options?: {
			ignoreInHaystack?: RegExp;
			ignoreInNeedle?: RegExp;
			caseInsensitive?: boolean;
		},
	) => { index: number; matchedText: string } | null;
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
		textFromEditTarget,
		translateCrossReferences,
		punctuationText,
		findPunctuationIndexAtEnd,
		resolveInnerLocationRangeInScope,
		formatStrikeInsertReplacementText,
		formatReplacementContent,
		boundaryAwareReplacementSuffix,
		computeFallbackRegexSearch,
		findAnchorSearchMatch,
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
	const throughContent = operation.edit.through
		? textFromEditTarget(operation.edit.through)
		: null;
	const throughPunctuation =
		operation.edit.through && "punctuation" in operation.edit.through
			? operation.edit.through.punctuation
			: undefined;
	const hasStructuralThroughTarget =
		operation.resolvedThroughTargetId !== null &&
		throughContent === null &&
		throughPunctuation === undefined;
	const normalizeBoundaryNewlines = (
		insertedText: string,
		start: number,
		end: number,
	): string => {
		const startsMidLine = start > 0 && plainText[start - 1] !== "\n";
		const nextChar = plainText[end] ?? "";
		const endsMidLine = nextChar.length > 0 && nextChar !== "\n";
		let normalized = insertedText;
		if (startsMidLine) {
			normalized = normalized.replace(/^\n+/, "");
		}
		if (endsMidLine) {
			const trailingHostText = plainText.slice(end).trimStart();
			const hostContinuesWithStructuralMarker = /^\([A-Za-z0-9ivxIVX]+\)/.test(
				trailingHostText,
			);
			if (!hostContinuesWithStructuralMarker) {
				normalized = normalized.replace(/\n+$/, "");
			}
		}
		return normalized;
	};

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
			if (operation.resolvedThroughTargetId) {
				const throughRange = getScopeRangeFromNodeId(
					model,
					operation.resolvedThroughTargetId,
				);
				if (!throughRange) return;
				const start = Math.min(innerRange.start, throughRange.start);
				const end = Math.max(innerRange.end, throughRange.end);
				const deleted = plainText.slice(start, end);
				const formattedReplacement = formatStrikeInsertReplacementText({
					model,
					content: replacementContent,
					insertStart: start,
					fallbackIndent: range.indent ?? 0,
				});
				pushPatch({
					start,
					end,
					deleted,
					inserted: formattedReplacement,
				});
				return;
			}
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

	const findFirstMatch = (
		needle: string,
		fromIndex = 0,
	): { index: number; matchedText: string } | null => {
		const searchText = scopedText.slice(fromIndex);
		const match = findAnchorSearchMatch(searchText, needle, {
			caseInsensitive: true,
		});
		return match
			? { index: fromIndex + match.index, matchedText: match.matchedText }
			: null;
	};
	const findLastMatch = (
		needle: string,
	): { index: number; matchedText: string } | null => {
		let fromIndex = 0;
		let lastMatch: { index: number; matchedText: string } | null = null;
		while (fromIndex < scopedText.length) {
			const match = findFirstMatch(needle, fromIndex);
			if (!match) break;
			lastMatch = match;
			fromIndex = match.index + 1;
		}
		return lastMatch;
	};
	const strikeMatch =
		operation.atEndOnly || atEndSearch
			? findLastMatch(strikingContent)
			: findFirstMatch(strikingContent);
	let localIndex = strikeMatch?.index ?? -1;
	let resolvedStrikingContent = strikeMatch?.matchedText ?? strikingContent;
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

	if (
		eachPlaceItAppears &&
		!throughContent &&
		!throughPunctuation &&
		!hasStructuralThroughTarget
	) {
		for (const occurrenceIndex of findAllOccurrences(
			scopedText,
			resolvedStrikingContent,
		)) {
			const patchStart = range.start + occurrenceIndex;
			const patchEnd = patchStart + resolvedStrikingContent.length;
			const formattedReplacement = formatStrikeInsertReplacementText({
				model,
				content: resolvedReplacementContent,
				insertStart: patchStart,
				fallbackIndent: range.indent ?? 0,
			});
			const normalizedReplacement = normalizeBoundaryNewlines(
				formattedReplacement,
				patchStart,
				patchEnd,
			);
			pushPatch({
				start: patchStart,
				end: patchEnd,
				deleted: resolvedStrikingContent,
				inserted: normalizedReplacement,
				insertedSuffixPlain: boundaryAwareReplacementSuffix(
					{ ...resolvedReplacementContent, text: normalizedReplacement },
					resolvedStrikingContent,
					plainText,
					patchEnd,
				),
			});
		}
		return;
	}

	const patchStart = range.start + localIndex;
	let patchEnd = patchStart + resolvedStrikingContent.length;
	let structuralThroughEnd: number | null = null;
	if (throughContent) {
		const throughMatch = findFirstMatch(
			throughContent,
			localIndex + resolvedStrikingContent.length,
		);
		if (!throughMatch) return;
		patchEnd =
			range.start + throughMatch.index + throughMatch.matchedText.length;
	}
	if (throughPunctuation) {
		const punctuation = punctuationText(throughPunctuation);
		const punctuationIndex = scopedText.indexOf(
			punctuation,
			localIndex + resolvedStrikingContent.length,
		);
		if (punctuationIndex < 0) return;
		patchEnd = range.start + punctuationIndex + punctuation.length;
	}
	if (hasStructuralThroughTarget) {
		const throughRange = getScopeRangeFromNodeId(
			model,
			operation.resolvedThroughTargetId,
		);
		if (!throughRange) return;
		structuralThroughEnd = throughRange.end;
		patchEnd = Math.max(patchEnd, structuralThroughEnd);
	}
	const formattedReplacement = formatStrikeInsertReplacementText({
		model,
		content: resolvedReplacementContent,
		insertStart: patchStart,
		fallbackIndent: range.indent ?? 0,
	});
	const normalizedReplacement = normalizeBoundaryNewlines(
		formattedReplacement,
		patchStart,
		patchEnd,
	);
	const deletedText = plainText.slice(patchStart, patchEnd);
	pushPatch({
		start: patchStart,
		end: patchEnd,
		deleted: deletedText,
		inserted: normalizedReplacement,
		insertedSuffixPlain: boundaryAwareReplacementSuffix(
			{ ...resolvedReplacementContent, text: normalizedReplacement },
			deletedText,
			plainText,
			patchEnd,
		),
	});
}
