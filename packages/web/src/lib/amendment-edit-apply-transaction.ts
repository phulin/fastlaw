import type {
	ApplyPlannedPatchesResult,
	CanonicalDocument,
	FormattingSpan,
	PlannedPatch,
} from "./amendment-edit-engine-types";

const OPENING_PUNCTUATION = new Set(["(", "[", "{", "/"]);
const CLOSING_PUNCTUATION = new Set([
	",",
	".",
	";",
	":",
	"?",
	"!",
	")",
	"]",
	"}",
]);

function isWordLike(value: string): boolean {
	return /^[A-Za-z0-9]$/.test(value);
}

function lastNonWhitespaceCharacter(value: string): string | null {
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const char = value[index];
		if (char && !/\s/.test(char)) return char;
	}
	return null;
}

function firstNonWhitespaceCharacter(value: string): string | null {
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char && !/\s/.test(char)) return char;
	}
	return null;
}

function trailingWhitespace(value: string): string {
	return value.match(/\s*$/)?.[0] ?? "";
}

function leadingWhitespace(value: string): string {
	return value.match(/^\s*/)?.[0] ?? "";
}

function shouldInsertPrefixSpace(
	leftChar: string | null,
	insertedFirstChar: string | null,
): boolean {
	if (!leftChar || !insertedFirstChar) return false;
	if (CLOSING_PUNCTUATION.has(insertedFirstChar)) return false;
	if (OPENING_PUNCTUATION.has(leftChar)) return false;
	if (
		(isWordLike(leftChar) || leftChar === ")") &&
		isWordLike(insertedFirstChar)
	) {
		return true;
	}
	if (insertedFirstChar === "(" && (isWordLike(leftChar) || leftChar === ")")) {
		return true;
	}
	return false;
}

function shouldInsertSuffixSpace(
	insertedLastChar: string | null,
	rightChar: string | null,
): boolean {
	if (!insertedLastChar || !rightChar) return false;
	if (CLOSING_PUNCTUATION.has(rightChar)) return false;
	if (OPENING_PUNCTUATION.has(insertedLastChar)) return false;
	return (
		(isWordLike(insertedLastChar) || insertedLastChar === ")") &&
		(isWordLike(rightChar) || rightChar === "(")
	);
}

function normalizeInsertionAffixes(args: {
	workingText: string;
	insertAt: number;
	deleteStart: number;
	deleteEnd: number;
	insertedPlain: string;
	insertedPrefixPlain: string;
	insertedSuffixPlain: string;
}): {
	insertedPrefixPlain: string;
	insertedSuffixPlain: string;
	outsidePrefixPlain: string;
	outsideSuffixPlain: string;
} {
	const {
		workingText,
		insertAt,
		deleteStart,
		deleteEnd,
		insertedPlain,
		insertedPrefixPlain,
		insertedSuffixPlain,
	} = args;
	if (insertedPlain.length === 0) {
		return {
			insertedPrefixPlain,
			insertedSuffixPlain,
			outsidePrefixPlain: "",
			outsideSuffixPlain: "",
		};
	}
	if (insertedPlain.includes("\n")) {
		return {
			insertedPrefixPlain,
			insertedSuffixPlain,
			outsidePrefixPlain: "",
			outsideSuffixPlain: "",
		};
	}

	let normalizedPrefix = insertedPrefixPlain;
	let normalizedSuffix = insertedSuffixPlain;
	let outsidePrefixPlain = "";
	let outsideSuffixPlain = "";
	const insertedFirstChar = firstNonWhitespaceCharacter(insertedPlain);
	const insertedLastChar = lastNonWhitespaceCharacter(insertedPlain);

	const leftContextBoundary = deleteEnd > deleteStart ? deleteStart : insertAt;
	const rightContextBoundary = deleteEnd > deleteStart ? deleteEnd : insertAt;
	const leftContext = workingText.slice(0, leftContextBoundary);
	const rightContext = workingText.slice(rightContextBoundary);
	const leftContextWhitespace = trailingWhitespace(leftContext);
	const rightContextWhitespace = leadingWhitespace(rightContext);
	const leftChar = lastNonWhitespaceCharacter(leftContext);
	const rightChar = firstNonWhitespaceCharacter(rightContext);

	const prefixLeadingWhitespace = leadingWhitespace(normalizedPrefix);
	const suffixTrailingWhitespace = trailingWhitespace(normalizedSuffix);
	const prefixBoundaryHasNewline =
		leftContextWhitespace.includes("\n") ||
		prefixLeadingWhitespace.includes("\n");
	const suffixBoundaryHasNewline =
		rightContextWhitespace.includes("\n") ||
		suffixTrailingWhitespace.includes("\n");

	if (!prefixBoundaryHasNewline) {
		if (
			leftContextWhitespace.length > 0 &&
			prefixLeadingWhitespace.length > 0
		) {
			normalizedPrefix = normalizedPrefix.replace(/^[ \t]+/, "");
		}
		if (
			leftContextWhitespace.length === 0 &&
			prefixLeadingWhitespace.length === 0 &&
			shouldInsertPrefixSpace(leftChar, insertedFirstChar)
		) {
			outsidePrefixPlain = " ";
		}
	}

	if (!suffixBoundaryHasNewline) {
		if (
			rightContextWhitespace.length > 0 &&
			suffixTrailingWhitespace.length > 0
		) {
			normalizedSuffix = normalizedSuffix.replace(/[ \t]+$/, "");
		}
		if (
			rightContextWhitespace.length === 0 &&
			suffixTrailingWhitespace.length === 0 &&
			shouldInsertSuffixSpace(insertedLastChar, rightChar)
		) {
			outsideSuffixPlain = " ";
		}
	}

	return {
		insertedPrefixPlain: normalizedPrefix,
		insertedSuffixPlain: normalizedSuffix,
		outsidePrefixPlain,
		outsideSuffixPlain,
	};
}

function shiftInsertedSpans(
	spans: FormattingSpan[],
	offset: number,
): FormattingSpan[] {
	return spans.map((span) => ({
		...span,
		start: span.start + offset,
		end: span.end + offset,
	}));
}

function startsAtLineBoundary(text: string, offset: number): boolean {
	if (offset <= 0) return true;
	return text[offset - 1] === "\n";
}

function isStructuralMarkerParagraph(text: string): boolean {
	return /^\s*\([A-Za-z0-9ivxIVX]+\)(?:\s|$)/.test(text);
}

function shiftSpansForInsertion(
	spans: FormattingSpan[],
	insertAt: number,
	insertedLength: number,
): FormattingSpan[] {
	if (insertedLength <= 0) return spans.map((span) => ({ ...span }));
	return spans.map((span) => {
		if (span.end <= insertAt) {
			if (
				span.end === insertAt &&
				(span.type === "paragraph" || span.type === "heading")
			) {
				return { ...span, end: span.end + insertedLength };
			}
			return { ...span };
		}
		if (span.start >= insertAt) {
			return {
				...span,
				start: span.start + insertedLength,
				end: span.end + insertedLength,
			};
		}
		return { ...span, end: span.end + insertedLength };
	});
}

function splitContainerSpansAroundInsertion(
	spans: FormattingSpan[],
	insertAt: number,
	insertedLength: number,
): FormattingSpan[] {
	if (insertedLength <= 0) return spans.map((span) => ({ ...span }));
	const result: FormattingSpan[] = [];
	for (const span of spans) {
		if (span.start >= span.end) continue;
		if (span.end <= insertAt) {
			result.push({ ...span });
			continue;
		}
		if (span.start >= insertAt) {
			result.push({
				...span,
				start: span.start + insertedLength,
				end: span.end + insertedLength,
			});
			continue;
		}
		if (span.type === "paragraph" || span.type === "heading") {
			const left = { ...span, end: insertAt };
			const right = {
				...span,
				start: insertAt + insertedLength,
				end: span.end + insertedLength,
			};
			if (left.end > left.start) result.push(left);
			if (right.end > right.start) result.push(right);
			continue;
		}
		result.push({ ...span, end: span.end + insertedLength });
	}
	return result;
}

function normalizeParagraphSpanContainment(
	spans: FormattingSpan[],
): FormattingSpan[] {
	const paragraphs = spans
		.filter((span) => span.type === "paragraph" && span.end > span.start)
		.map((span) => ({ ...span }));
	const nonParagraphs = spans
		.filter((span) => span.type !== "paragraph" && span.end > span.start)
		.map((span) => ({ ...span }));

	const sorted = paragraphs.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	const normalized: FormattingSpan[] = [];

	for (const paragraph of sorted) {
		const next = { ...paragraph };
		const previous = normalized[normalized.length - 1];
		if (!previous) {
			normalized.push(next);
			continue;
		}
		if (next.start >= previous.end) {
			normalized.push(next);
			continue;
		}

		previous.end = Math.max(previous.end, next.end);
	}

	return [...nonParagraphs, ...normalized];
}

function materializeEditsFromPatches(
	model: CanonicalDocument,
	patches: PlannedPatch[],
): { plainText: string; spans: FormattingSpan[] } {
	const orderedPatches = patches
		.map((patch, patchId) => ({ patch, patchId }))
		.sort((left, right) => {
			if (left.patch.start !== right.patch.start) {
				return right.patch.start - left.patch.start;
			}
			return right.patchId - left.patchId;
		});

	let workingText = model.plainText;
	let workingSpans = model.spans.map((span) => ({ ...span }));

	for (const { patch } of orderedPatches) {
		const deleteStart = patch.start;
		const deleteEnd = patch.end;
		const deletedLength = deleteEnd - deleteStart;
		const insertedPlain = patch.insertedPlain;
		const insertedSpans = patch.insertedSpans;
		const normalizedAffixes = normalizeInsertionAffixes({
			workingText,
			insertAt: patch.insertAt,
			deleteStart,
			deleteEnd,
			insertedPlain,
			insertedPrefixPlain: patch.insertedPrefixPlain ?? "",
			insertedSuffixPlain: patch.insertedSuffixPlain ?? "",
		});
		const insertedPrefixPlain = normalizedAffixes.insertedPrefixPlain;
		const insertedSuffixPlain = normalizedAffixes.insertedSuffixPlain;
		const outsidePrefixPlain = normalizedAffixes.outsidePrefixPlain;
		const outsideSuffixPlain = normalizedAffixes.outsideSuffixPlain;
		const insertedTotalLength =
			insertedPrefixPlain.length +
			insertedPlain.length +
			insertedSuffixPlain.length;
		const totalInsertedLength =
			outsidePrefixPlain.length +
			insertedTotalLength +
			outsideSuffixPlain.length;

		if (deletedLength > 0) {
			workingSpans.push({
				type: "deletion",
				start: deleteStart,
				end: deleteEnd,
			});
		}

		const insertAt = patch.insertAt;

		if (totalInsertedLength > 0) {
			const rightContextTextBeforeInsert = workingText.slice(insertAt);
			const insertedHasParagraphs = insertedSpans.some(
				(span) => span.type === "paragraph",
			);
			const shouldSplitContainerSpans = insertedHasParagraphs;
			const shiftedInsertStart =
				insertAt + outsidePrefixPlain.length + insertedPrefixPlain.length;
			const insertedParagraphs = insertedSpans
				.filter((span) => span.type === "paragraph")
				.sort(
					(left, right) => left.start - right.start || left.end - right.end,
				);
			const firstInsertedParagraph = insertedParagraphs[0];
			const lastInsertedParagraph =
				insertedParagraphs.length > 0
					? insertedParagraphs[insertedParagraphs.length - 1]
					: undefined;
			const firstInsertedParagraphText =
				firstInsertedParagraph &&
				firstInsertedParagraph.end > firstInsertedParagraph.start
					? insertedPlain.slice(
							firstInsertedParagraph.start,
							firstInsertedParagraph.end,
						)
					: "";
			const preserveLeadingContinuationInLeftParagraph =
				insertedHasParagraphs &&
				!startsAtLineBoundary(workingText, insertAt) &&
				insertedPlain.length > 0 &&
				!insertedPlain.startsWith("\n") &&
				firstInsertedParagraph?.start === 0 &&
				firstInsertedParagraphText.trim().length > 0 &&
				!isStructuralMarkerParagraph(firstInsertedParagraphText);
			const rightContextLeadingChar = rightContextTextBeforeInsert[0] ?? "";
			const rightContextStartsWithStructuralMarker =
				/^\s*\([A-Za-z0-9ivxIVX]+\)/.test(rightContextTextBeforeInsert);
			const replacementStartsAtLineBoundary =
				deletedLength > 0 && startsAtLineBoundary(workingText, deleteStart);
			const preserveTrailingContinuationInLastInsertedParagraph =
				insertedHasParagraphs &&
				replacementStartsAtLineBoundary &&
				insertedPlain.length > 0 &&
				!insertedPlain.endsWith("\n") &&
				rightContextLeadingChar.length > 0 &&
				rightContextLeadingChar !== "\n" &&
				lastInsertedParagraph !== undefined &&
				!rightContextStartsWithStructuralMarker;
			workingText = `${workingText.slice(0, insertAt)}${outsidePrefixPlain}${insertedPrefixPlain}${insertedPlain}${insertedSuffixPlain}${outsideSuffixPlain}${workingText.slice(insertAt)}`;
			workingSpans = shouldSplitContainerSpans
				? splitContainerSpansAroundInsertion(
						workingSpans,
						insertAt,
						totalInsertedLength,
					)
				: shiftSpansForInsertion(workingSpans, insertAt, totalInsertedLength);
			if (
				preserveLeadingContinuationInLeftParagraph &&
				firstInsertedParagraph !== undefined
			) {
				const leadingContinuationLength = firstInsertedParagraph.end;
				workingSpans = workingSpans.map((span) => {
					if (
						(span.type === "paragraph" || span.type === "heading") &&
						span.end === insertAt
					) {
						return { ...span, end: span.end + leadingContinuationLength };
					}
					return span;
				});
			}
			if (insertedTotalLength > 0) {
				const effectiveInsertedSpans =
					preserveLeadingContinuationInLeftParagraph &&
					firstInsertedParagraph !== undefined
						? insertedSpans
								.map((span) => {
									if (span.type !== "paragraph") return span;
									if (span.end <= firstInsertedParagraph.end) {
										return null;
									}
									if (span.start < firstInsertedParagraph.end) {
										return {
											...span,
											start: firstInsertedParagraph.end,
										};
									}
									return span;
								})
								.filter((span): span is FormattingSpan => span !== null)
						: insertedSpans;
				workingSpans.push(
					...shiftInsertedSpans(effectiveInsertedSpans, shiftedInsertStart),
				);
				if (
					preserveTrailingContinuationInLastInsertedParagraph &&
					lastInsertedParagraph !== undefined
				) {
					const mergedParagraphStart =
						shiftedInsertStart + lastInsertedParagraph.start;
					const insertionBoundary = shiftedInsertStart + insertedTotalLength;
					const rightBoundaryMax = insertAt + totalInsertedLength;
					workingSpans = workingSpans.map((span) => {
						if (
							(span.type === "paragraph" || span.type === "heading") &&
							span.start >= insertionBoundary &&
							span.start <= rightBoundaryMax &&
							span.end > span.start
						) {
							return { ...span, start: mergedParagraphStart };
						}
						return span;
					});
				}
				workingSpans.push({
					type: "insertion",
					start: insertAt + outsidePrefixPlain.length,
					end: insertAt + outsidePrefixPlain.length + insertedTotalLength,
				});
			}
		}
	}

	return {
		plainText: workingText,
		spans: normalizeParagraphSpanContainment(
			workingSpans.filter((span) => span.end > span.start),
		),
	};
}

export function applyPlannedPatchesTransaction(
	model: CanonicalDocument,
	patches: PlannedPatch[],
): ApplyPlannedPatchesResult {
	const materialized = materializeEditsFromPatches(model, patches);
	return {
		plainText: materialized.plainText,
		spans: materialized.spans,
	};
}

export function applyPlannedPatchesToWorkingText(
	plainText: string,
	patches: PlannedPatch[],
): string {
	const orderedPatches = patches
		.map((patch, patchId) => ({ patch, patchId }))
		.sort((left, right) => {
			if (left.patch.start !== right.patch.start) {
				return right.patch.start - left.patch.start;
			}
			return right.patchId - left.patchId;
		});

	let workingText = plainText;

	for (const { patch } of orderedPatches) {
		const deleteStart = patch.start;
		const deleteEnd = patch.end;
		const normalizedAffixes = normalizeInsertionAffixes({
			workingText,
			insertAt: patch.insertAt,
			deleteStart,
			deleteEnd,
			insertedPlain: patch.insertedPlain,
			insertedPrefixPlain: patch.insertedPrefixPlain ?? "",
			insertedSuffixPlain: patch.insertedSuffixPlain ?? "",
		});
		const replacementText = `${normalizedAffixes.outsidePrefixPlain}${normalizedAffixes.insertedPrefixPlain}${patch.insertedPlain}${normalizedAffixes.insertedSuffixPlain}${normalizedAffixes.outsideSuffixPlain}`;
		workingText = `${workingText.slice(0, deleteStart)}${replacementText}${workingText.slice(deleteEnd)}`;
	}

	return workingText;
}
