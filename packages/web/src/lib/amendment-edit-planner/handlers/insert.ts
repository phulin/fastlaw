import { getScopeRangeFromNodeId } from "../../amendment-document-model";
import type {
	CanonicalDocument,
	ClassificationOverride,
	OperationMatchAttempt,
	ScopeRange,
} from "../../amendment-edit-engine-types";
import type { CanonicalPlanningOperation } from "../../amendment-edit-operation-adapter";
import type { EditTarget, TextWithProvenance } from "../../amendment-edit-tree";

const INSIDE_WORD_HYPHEN_RE = /(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/g;

interface PushPatchArgs {
	start: number;
	end: number;
	deleted: string;
	inserted?: string;
	insertedPrefixPlain?: string;
	insertedSuffixPlain?: string;
	insertAt?: number;
}

interface InsertHandlerArgs {
	model: CanonicalDocument;
	operation: CanonicalPlanningOperation;
	range: ScopeRange | null;
	scopedText: string;
	plainText: string;
	attempt: OperationMatchAttempt;
	classificationOverrides?: ClassificationOverride[];
	pushPatch: (args: PushPatchArgs) => void;
	textFromEditTarget: (target: EditTarget) => string | null;
	translateCrossReferences: (
		text: string,
		classificationOverrides?: ClassificationOverride[],
	) => string;
	findAnchorSearchMatch: (
		haystack: string,
		needle: string,
		options?: {
			ignoreInHaystack?: RegExp;
			ignoreInNeedle?: RegExp;
		},
	) => { index: number; matchedText: string } | null;
	computeFallbackAnchorRegexSearch: (anchorText: string) => RegExp | null;
	extractAnchor: (
		nodeText: string,
		direction: "before" | "after",
	) => string | null;
	formatInsertionContent: (
		content: TextWithProvenance,
		indent: number,
	) => TextWithProvenance;
	formatBlockInsertionContent: (
		content: TextWithProvenance,
		indent: number,
	) => TextWithProvenance;
}

export function handleInsertEdit(args: InsertHandlerArgs): void {
	const {
		model,
		operation,
		range,
		scopedText,
		plainText,
		attempt,
		classificationOverrides,
		pushPatch,
		textFromEditTarget,
		translateCrossReferences,
		findAnchorSearchMatch,
		computeFallbackAnchorRegexSearch,
		extractAnchor,
		formatInsertionContent,
		formatBlockInsertionContent,
	} = args;
	if (!range) return;
	if (operation.edit.kind !== "insert") return;

	let contentText = operation.edit.content.text;
	contentText = translateCrossReferences(contentText, classificationOverrides);
	const content = {
		...operation.edit.content,
		text: contentText,
	};

	if (operation.edit.before) {
		const anchor = textFromEditTarget(operation.edit.before);
		const translatedAnchor = anchor
			? translateCrossReferences(anchor, classificationOverrides)
			: null;
		let anchorStart: number | null = null;
		let resolvedAnchor: string | null = translatedAnchor;
		if (translatedAnchor) {
			let localIndex = scopedText.indexOf(translatedAnchor);
			if (localIndex < 0) {
				const ignoredTextMatch = findAnchorSearchMatch(
					scopedText,
					translatedAnchor,
					{
						ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
						ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
					},
				);
				if (ignoredTextMatch) {
					localIndex = ignoredTextMatch.index;
					resolvedAnchor = ignoredTextMatch.matchedText;
				}
			}
			if (localIndex < 0) {
				const fallback = computeFallbackAnchorRegexSearch(translatedAnchor);
				const fallbackMatch = fallback ? scopedText.match(fallback) : null;
				if (fallbackMatch && fallbackMatch.index !== undefined) {
					localIndex = fallbackMatch.index;
					resolvedAnchor = fallbackMatch[0];
				}
			}
			attempt.searchText = resolvedAnchor ?? translatedAnchor;
			attempt.searchTextKind = "anchor_before";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (resolvedAnchor !== anchor) attempt.wasTranslated = true;
			if (localIndex >= 0) anchorStart = range.start + localIndex;
		} else if (operation.resolvedAnchorTargetId !== null) {
			const anchorRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedAnchorTargetId,
			);
			if (anchorRange) anchorStart = anchorRange.start;
		} else {
			const extracted = extractAnchor(operation.nodeText, "before");
			if (extracted) {
				const localIndex = scopedText.indexOf(extracted);
				attempt.searchText = extracted;
				attempt.searchTextKind = "anchor_before";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex >= 0) anchorStart = range.start + localIndex;
			}
		}
		if (anchorStart === null) return;
		const formatted = formatInsertionContent(content, range.indent ?? 0);
		const formattedText = formatted.text;
		const suffix = resolvedAnchor
			? /[A-Za-z0-9)]$/.test(formattedText) &&
				/^[A-Za-z0-9(]/.test(resolvedAnchor)
				? " "
				: ""
			: formattedText.endsWith("\n")
				? ""
				: "\n";
		pushPatch({
			start: anchorStart,
			end: anchorStart,
			deleted: "",
			inserted: formatted.text,
			insertedSuffixPlain: suffix,
		});
		return;
	}

	if (operation.edit.after) {
		const anchor = textFromEditTarget(operation.edit.after);
		const translatedAnchor = anchor
			? translateCrossReferences(anchor, classificationOverrides)
			: null;
		let anchorEnd: number | null = null;
		let resolvedAnchor: string | null = translatedAnchor;
		if (translatedAnchor) {
			let localIndex = scopedText.indexOf(translatedAnchor);
			if (localIndex < 0) {
				const ignoredTextMatch = findAnchorSearchMatch(
					scopedText,
					translatedAnchor,
					{
						ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
						ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
					},
				);
				if (ignoredTextMatch) {
					localIndex = ignoredTextMatch.index;
					resolvedAnchor = ignoredTextMatch.matchedText;
				}
			}
			if (localIndex < 0) {
				const fallback = computeFallbackAnchorRegexSearch(translatedAnchor);
				const fallbackMatch = fallback ? scopedText.match(fallback) : null;
				if (fallbackMatch && fallbackMatch.index !== undefined) {
					localIndex = fallbackMatch.index;
					resolvedAnchor = fallbackMatch[0];
				}
			}
			attempt.searchText = resolvedAnchor;
			attempt.searchTextKind = "anchor_after";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (resolvedAnchor !== anchor) attempt.wasTranslated = true;
			if (localIndex >= 0) {
				anchorEnd =
					range.start +
					localIndex +
					(resolvedAnchor ?? translatedAnchor).length;
			}
		} else if (operation.resolvedAnchorTargetId !== null) {
			const anchorRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedAnchorTargetId,
			);
			if (anchorRange) anchorEnd = anchorRange.end;
		} else {
			const extracted = extractAnchor(operation.nodeText, "after");
			if (extracted) {
				const localIndex = scopedText.indexOf(extracted);
				attempt.searchText = extracted;
				attempt.searchTextKind = "anchor_after";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex >= 0) {
					anchorEnd = range.start + localIndex + extracted.length;
				}
			}
		}
		if (anchorEnd === null) return;
		const formatted = formatInsertionContent(content, range.indent ?? 0);
		const formattedText = formatted.text;
		const prefix = translatedAnchor
			? /[A-Za-z0-9)]$/.test(translatedAnchor) &&
				/^[A-Za-z0-9(]/.test(formattedText)
				? " "
				: ""
			: plainText[anchorEnd - 1] === "\n" || anchorEnd === 0
				? ""
				: "\n";
		pushPatch({
			start: anchorEnd,
			end: anchorEnd,
			deleted: "",
			inserted: formatted.text,
			insertedPrefixPlain: prefix,
		});
		return;
	}

	if (operation.addAtEnd) {
		const insertAt = range.end;
		const beforeChar = plainText[insertAt - 1] ?? "";
		const afterChar = plainText[insertAt] ?? "";
		const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
		const formatted = formatBlockInsertionContent(content, range.indent ?? 0);
		const suffix = afterChar && afterChar !== "\n" ? "\n\n" : "\n";
		pushPatch({
			start: insertAt,
			end: insertAt,
			deleted: "",
			inserted: formatted.text,
			insertedPrefixPlain: prefix,
			insertedSuffixPlain: suffix,
		});
		return;
	}

	const insertAt = range.end;
	const beforeChar = plainText[insertAt - 1] ?? "";
	const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
	const formatted = formatInsertionContent(content, range.indent ?? 0);
	pushPatch({
		start: insertAt,
		end: insertAt,
		deleted: "",
		inserted: formatted.text,
		insertedPrefixPlain: prefix,
	});
}
