import {
	getScopeRangeFromNodeId,
	parseMarkdownToPlainDocument,
} from "./amendment-document-model";
import type {
	DocumentModel,
	FormattingSpan,
	OperationMatchAttempt,
	PlanEditsResult,
	PlannedPatch,
	ResolvedInstructionOperation,
	ScopeRange,
} from "./amendment-edit-engine-types";
import {
	PunctuationKind,
	type TextWithProvenance,
	textFromEditTarget,
	textSearchFromEditTarget,
	UltimateEditKind,
} from "./amendment-edit-tree";
import { formatInsertedBlockContent } from "./inserted-block-format";
import type { ParagraphRange } from "./types";

function previewRange(text: string, range: ScopeRange | null): string {
	if (!range) return "";
	return text.slice(range.start, Math.min(range.end, range.start + 180));
}

function punctuationText(kind: PunctuationKind): string {
	switch (kind) {
		case PunctuationKind.Period:
			return ".";
		case PunctuationKind.Comma:
			return ",";
		case PunctuationKind.Semicolon:
			return ";";
	}
}

function paragraphTexts(range: ParagraphRange): string[] {
	return range.paragraphs.map((p, i) => {
		if (i === 0 && i === range.paragraphs.length - 1) {
			return p.text.slice(range.startFirst, range.endLast);
		} else if (i === 0) {
			return p.text.slice(range.startFirst);
		} else if (i === range.paragraphs.length - 1) {
			return p.text.slice(0, range.endLast);
		}
		return p.text;
	});
}

function formatContentRanges(
	content: TextWithProvenance,
	baseDepth: number,
): TextWithProvenance {
	const { paragraphs } = content.sourceLocation;
	const hasLevelInfo = paragraphs.some((p) => p.level !== undefined);
	if (!hasLevelInfo) {
		return {
			text: formatInsertedBlockContent(content.text, {
				baseDepth,
				quotePlainMultiline: true,
			}),
			sourceLocation: content.sourceLocation,
		};
	}
	const levels = paragraphs.map((p) => p.level ?? 0);
	const minLevel = Math.min(...levels);
	const texts = paragraphTexts(content.sourceLocation);
	const formattedText = texts
		.map((text, i) => {
			const depth = baseDepth + ((levels[i] ?? minLevel) - minLevel);
			return formatInsertedBlockContent(text, {
				baseDepth: depth,
				quotePlainMultiline: true,
			});
		})
		.join("\n");
	return { text: formattedText, sourceLocation: content.sourceLocation };
}

function formatInsertionContent(
	content: TextWithProvenance,
	targetLevel: number,
): TextWithProvenance {
	return formatContentRanges(content, targetLevel + 1);
}

function formatReplacementContent(
	content: TextWithProvenance,
	targetLevel: number,
): TextWithProvenance {
	return formatContentRanges(content, targetLevel);
}

function multilineReplacementSuffix(
	inserted: TextWithProvenance,
	text: string,
	rangeEnd: number,
): string {
	if (!inserted.text.includes("\n")) return "";
	if (inserted.text.endsWith("\n")) return "";
	const nextChar = text[rangeEnd] ?? "";
	if (nextChar.length === 0 || nextChar === "\n") return "";
	return "\n";
}

function normalizeInsertedSpans(
	spans: FormattingSpan[],
	insertedPlain: string,
): FormattingSpan[] {
	if (insertedPlain.length === 0) return [];
	const hasMultiline = insertedPlain.includes("\n");
	return spans
		.filter((span) => {
			if (span.type === "insertion" || span.type === "deletion") return false;
			if (!hasMultiline) {
				return (
					span.type !== "paragraph" &&
					span.type !== "blockquote" &&
					span.type !== "heading"
				);
			}
			return true;
		})
		.map((span) => ({ ...span }));
}

function parseInsertedText(sourceText: string): {
	insertedPlain: string;
	insertedSpans: FormattingSpan[];
} {
	if (sourceText.length === 0) {
		return { insertedPlain: "", insertedSpans: [] };
	}
	const parsed = parseMarkdownToPlainDocument(sourceText);
	return {
		insertedPlain: parsed.plainText,
		insertedSpans: normalizeInsertedSpans(parsed.spans, parsed.plainText),
	};
}

function formatBlockInsertionContent(
	content: TextWithProvenance,
	targetLevel: number,
): TextWithProvenance {
	return formatContentRanges(content, targetLevel + 1);
}

function resolveSentenceOrdinalRange(
	text: string,
	ordinal: number,
): { start: number; end: number } | null {
	if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
		const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
		const sentences = Array.from(segmenter.segment(text));
		if (sentences.length === 0) return null;
		const sentenceIndex =
			ordinal <= 0
				? sentences.length - 1
				: Math.min(ordinal - 1, sentences.length - 1);
		const sentence = sentences[sentenceIndex];
		if (sentence && typeof sentence.index === "number") {
			const start = sentence.index;
			const end = sentence.index + sentence.segment.length;
			return { start, end };
		}
	}

	const matches = Array.from(text.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g));
	if (matches.length === 0) return null;
	const sentenceIndex =
		ordinal <= 0
			? matches.length - 1
			: Math.min(ordinal - 1, matches.length - 1);
	const sentence = matches[sentenceIndex];
	if (!sentence) return null;
	const start = sentence.index ?? 0;
	const end = start + sentence[0].length;
	return { start, end };
}

function extractAnchor(
	nodeText: string,
	direction: "before" | "after",
): string | null {
	const pattern = new RegExp(`${direction}\\s+["""„‟'']([^""'']+)[""'']`, "i");
	const match = nodeText.match(pattern);
	return match?.[1] ?? null;
}

function getEditStrikingContent(
	operation: ResolvedInstructionOperation,
): string | null {
	const { edit } = operation;
	if (edit.kind === UltimateEditKind.Strike) {
		return textFromEditTarget(edit.target);
	}
	if (edit.kind === UltimateEditKind.StrikeInsert) {
		return textFromEditTarget(edit.strike);
	}
	return null;
}

function overlaps(left: PlannedPatch, right: PlannedPatch): boolean {
	const leftPoint = left.start === left.end;
	const rightPoint = right.start === right.end;
	if (leftPoint && rightPoint && left.start === right.start) return false;
	return left.start < right.end && right.start < left.end;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
	if (needle.length === 0) return [];
	const indexes: number[] = [];
	let cursor = 0;
	while (cursor <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index < 0) break;
		indexes.push(index);
		cursor = index + needle.length;
	}
	return indexes;
}

function normalizeInlineDeletionRange(
	text: string,
	start: number,
	end: number,
): { start: number; end: number } {
	if (start >= end) return { start, end };
	const deleted = text.slice(start, end);
	if (deleted.includes("\n")) return { start, end };
	const beforeChar = text[start - 1] ?? "";
	const afterChar = text[end] ?? "";
	if (beforeChar === " " && afterChar === " ") {
		return { start: start - 1, end };
	}
	return { start, end };
}

function buildAttempt(
	operation: ResolvedInstructionOperation,
	range: ScopeRange | null,
	plainText: string,
): OperationMatchAttempt {
	return {
		operationType: operation.edit.kind,
		nodeText: operation.nodeText,
		strikingContent: getEditStrikingContent(operation),
		targetPath: operation.targetPathText,
		hasExplicitTargetPath: operation.hasExplicitTargetPath,
		scopedRange: range
			? {
					start: range.start,
					end: range.end,
					length: range.end - range.start,
					preview: previewRange(plainText, range),
				}
			: null,
		searchText: null,
		searchTextKind: "none",
		searchIndex: null,
		patchApplied: false,
		outcome: "no_patch",
	};
}

function planPatchForOperation(
	model: DocumentModel,
	operation: ResolvedInstructionOperation,
): { patches: PlannedPatch[]; attempt: OperationMatchAttempt } {
	const plainText = model.plainText;
	const baseRange = getScopeRangeFromNodeId(model, operation.resolvedTargetId);
	let range = baseRange;
	const attempt = buildAttempt(operation, range, plainText);

	if (operation.hasExplicitTargetPath && !operation.resolvedTargetId) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}
	if (!range && operation.edit.kind !== UltimateEditKind.Move) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}

	if (range && operation.hasMatterPrecedingTarget) {
		if (!operation.resolvedMatterPrecedingTargetId) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const matterTargetRange = getScopeRangeFromNodeId(
			model,
			operation.resolvedMatterPrecedingTargetId,
		);
		if (!matterTargetRange) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const boundary = Math.min(matterTargetRange.start, range.end);
		range = { ...range, end: Math.max(range.start, boundary) };
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	if (range && operation.hasMatterFollowingTarget) {
		if (!operation.resolvedMatterFollowingTargetId) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const matterTargetRange = getScopeRangeFromNodeId(
			model,
			operation.resolvedMatterFollowingTargetId,
		);
		if (!matterTargetRange) {
			attempt.outcome = "scope_unresolved";
			return { patches: [], attempt };
		}
		const boundary = Math.max(matterTargetRange.end, range.start);
		range = { ...range, start: Math.min(boundary, range.end) };
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(plainText, range),
		};
	}

	if (range && typeof operation.sentenceOrdinal === "number") {
		const sentenceRange = resolveSentenceOrdinalRange(
			plainText.slice(range.start, range.end),
			operation.sentenceOrdinal,
		);
		if (sentenceRange) {
			const baseStart = range.start;
			range = {
				...range,
				start: baseStart + sentenceRange.start,
				end: baseStart + sentenceRange.end,
			};
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: range.end - range.start,
				preview: previewRange(plainText, range),
			};
		} else {
			range = { ...range, start: range.end };
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: 0,
				preview: "",
			};
		}
	}

	const scopedText = range ? plainText.slice(range.start, range.end) : "";
	const patches: PlannedPatch[] = [];
	const pushPatch = (args: {
		start: number;
		end: number;
		deleted: string;
		inserted?: string;
		insertedPrefixPlain?: string;
		insertedSuffixPlain?: string;
		insertAt?: number;
	}) => {
		const inserted = parseInsertedText(args.inserted ?? "");
		patches.push({
			operationIndex: operation.operationIndex,
			start: args.start,
			end: args.end,
			insertAt:
				args.insertAt ?? (args.start < args.end ? args.end : args.start),
			deletedPlain: args.deleted,
			insertedPlain: inserted.insertedPlain,
			insertedSpans: inserted.insertedSpans,
			insertedPrefixPlain: args.insertedPrefixPlain,
			insertedSuffixPlain: args.insertedSuffixPlain,
		});
	};

	switch (operation.edit.kind) {
		case UltimateEditKind.StrikeInsert: {
			if (!range) break;
			const strikeSearch = textSearchFromEditTarget(operation.edit.strike);
			const strikingContent = strikeSearch?.text ?? null;
			const replacementContent = operation.edit.insert;
			const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;

			if (!strikingContent) {
				// Range replace (through-target)
				if (operation.resolvedThroughTargetId) {
					const throughRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedThroughTargetId,
					);
					if (!throughRange) break;
					const sameTargetLevel =
						throughRange.targetLevel !== undefined &&
						range.targetLevel !== undefined &&
						throughRange.targetLevel === range.targetLevel;
					if (!sameTargetLevel) {
						const formatted = formatReplacementContent(
							replacementContent,
							range.targetLevel ?? 0,
						);
						pushPatch({
							start: range.start,
							end: range.end,
							deleted: scopedText,
							inserted: formatted.text,
							insertedSuffixPlain: multilineReplacementSuffix(
								formatted,
								plainText,
								range.end,
							),
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					const formatted = formatReplacementContent(
						replacementContent,
						range.targetLevel ?? 0,
					);
					pushPatch({
						start,
						end,
						deleted: plainText.slice(start, end),
						inserted: formatted.text,
						insertedSuffixPlain: multilineReplacementSuffix(
							formatted,
							plainText,
							end,
						),
					});
					break;
				}
				const formatted = formatReplacementContent(
					replacementContent,
					range.targetLevel ?? 0,
				);
				pushPatch({
					start: range.start,
					end: range.end,
					deleted: scopedText,
					inserted: formatted.text,
					insertedSuffixPlain: multilineReplacementSuffix(
						formatted,
						plainText,
						range.end,
					),
				});
				break;
			}

			const localIndex = scopedText.indexOf(strikingContent);
			attempt.searchText = strikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;

			if (eachPlaceItAppears) {
				for (const occurrenceIndex of findAllOccurrences(
					scopedText,
					strikingContent,
				)) {
					pushPatch({
						start: range.start + occurrenceIndex,
						end: range.start + occurrenceIndex + strikingContent.length,
						deleted: strikingContent,
						inserted: replacementContent.text,
					});
				}
				break;
			}

			pushPatch({
				start: range.start + localIndex,
				end: range.start + localIndex + strikingContent.length,
				deleted: strikingContent,
				inserted: replacementContent.text,
			});
			break;
		}

		case UltimateEditKind.Rewrite: {
			if (!range) break;
			const replacementContent = operation.edit.content;
			const formatted = formatReplacementContent(
				replacementContent,
				range.targetLevel ?? 0,
			);
			pushPatch({
				start: range.start,
				end: range.end,
				deleted: scopedText,
				inserted: formatted.text,
				insertedSuffixPlain: multilineReplacementSuffix(
					formatted,
					plainText,
					range.end,
				),
			});
			break;
		}

		case UltimateEditKind.Strike: {
			if (!range) break;
			const strikeSearch = textSearchFromEditTarget(operation.edit.target);
			const strikingContent = strikeSearch?.text ?? null;
			const eachPlaceItAppears = strikeSearch?.eachPlaceItAppears === true;
			const throughContent = operation.edit.through
				? textFromEditTarget(operation.edit.through)
				: null;
			const throughPunctuation =
				operation.edit.through && "punctuation" in operation.edit.through
					? operation.edit.through.punctuation
					: undefined;

			if (!strikingContent) {
				if (operation.resolvedThroughTargetId) {
					const throughRange = getScopeRangeFromNodeId(
						model,
						operation.resolvedThroughTargetId,
					);
					if (!throughRange) break;
					const sameTargetLevel =
						throughRange.targetLevel !== undefined &&
						range.targetLevel !== undefined &&
						throughRange.targetLevel === range.targetLevel;
					if (!sameTargetLevel) {
						pushPatch({
							start: range.start,
							end: range.end,
							deleted: scopedText,
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					pushPatch({
						start,
						end,
						deleted: plainText.slice(start, end),
					});
					break;
				}
				pushPatch({
					start: range.start,
					end: range.end,
					deleted: scopedText,
				});
				break;
			}

			const localStart = scopedText.indexOf(strikingContent);
			attempt.searchText = strikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localStart >= 0 ? range.start + localStart : null;
			if (localStart < 0) break;

			if (eachPlaceItAppears && !throughContent && !throughPunctuation) {
				for (const occurrenceIndex of findAllOccurrences(
					scopedText,
					strikingContent,
				)) {
					const patchRange = normalizeInlineDeletionRange(
						plainText,
						range.start + occurrenceIndex,
						range.start + occurrenceIndex + strikingContent.length,
					);
					pushPatch({
						start: patchRange.start,
						end: patchRange.end,
						deleted: plainText.slice(patchRange.start, patchRange.end),
					});
				}
				break;
			}

			let localEnd = localStart + strikingContent.length;
			if (throughContent) {
				const throughStart = scopedText.indexOf(
					throughContent,
					localStart + strikingContent.length,
				);
				if (throughStart < 0) break;
				localEnd = throughStart + throughContent.length;
			}
			if (throughPunctuation) {
				const punctuation = punctuationText(throughPunctuation);
				const punctuationIndex = scopedText.indexOf(
					punctuation,
					localStart + strikingContent.length,
				);
				if (punctuationIndex < 0) break;
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
			break;
		}

		case UltimateEditKind.Insert: {
			if (!range) break;
			const content = operation.edit.content;

			if (operation.edit.before) {
				const anchor = textFromEditTarget(operation.edit.before);
				let anchorStart: number | null = null;
				if (anchor) {
					const localIndex = scopedText.indexOf(anchor);
					attempt.searchText = anchor;
					attempt.searchTextKind = "anchor_before";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
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
						attempt.searchIndex =
							localIndex >= 0 ? range.start + localIndex : null;
						if (localIndex >= 0) anchorStart = range.start + localIndex;
					}
				}
				if (anchorStart === null) break;
				const formatted = formatInsertionContent(
					content,
					range.targetLevel ?? 0,
				);
				const formattedText = formatted.text;
				const suffix = anchor
					? /[A-Za-z0-9)]$/.test(formattedText) && /^[A-Za-z0-9(]/.test(anchor)
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
				break;
			}

			if (operation.edit.after) {
				const anchor = textFromEditTarget(operation.edit.after);
				let anchorEnd: number | null = null;
				if (anchor) {
					const localIndex = scopedText.indexOf(anchor);
					attempt.searchText = anchor;
					attempt.searchTextKind = "anchor_after";
					attempt.searchIndex =
						localIndex >= 0 ? range.start + localIndex : null;
					if (localIndex >= 0)
						anchorEnd = range.start + localIndex + anchor.length;
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
						attempt.searchIndex =
							localIndex >= 0 ? range.start + localIndex : null;
						if (localIndex >= 0)
							anchorEnd = range.start + localIndex + extracted.length;
					}
				}
				if (anchorEnd === null) break;
				const formatted = formatInsertionContent(
					content,
					range.targetLevel ?? 0,
				);
				const formattedText = formatted.text;
				const prefix = anchor
					? /[A-Za-z0-9)]$/.test(anchor) && /^[A-Za-z0-9(]/.test(formattedText)
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
				break;
			}

			if (operation.addAtEnd) {
				const insertAt = range.end;
				const beforeChar = plainText[insertAt - 1] ?? "";
				const afterChar = plainText[insertAt] ?? "";
				const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
				const formatted = formatBlockInsertionContent(
					content,
					range.targetLevel ?? 0,
				);
				const suffix = afterChar && afterChar !== "\n" ? "\n\n" : "\n";
				pushPatch({
					start: insertAt,
					end: insertAt,
					deleted: "",
					inserted: formatted.text,
					insertedPrefixPlain: prefix,
					insertedSuffixPlain: suffix,
				});
				break;
			}

			// Plain insert at end of scope range
			const insertAt = range.end;
			const beforeChar = plainText[insertAt - 1] ?? "";
			const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
			const formatted = formatInsertionContent(content, range.targetLevel ?? 0);
			pushPatch({
				start: insertAt,
				end: insertAt,
				deleted: "",
				inserted: formatted.text,
				insertedPrefixPlain: prefix,
			});
			break;
		}

		case UltimateEditKind.Redesignate: {
			if (!range) break;
			const mapping =
				operation.edit.mappings[operation.redesignateMappingIndex];
			if (!mapping) break;
			const fromLabel =
				mapping.from.path[mapping.from.path.length - 1]?.label ?? "";
			const toLabel = mapping.to.path[mapping.to.path.length - 1]?.label ?? "";
			const marker = `(${fromLabel})`;
			const replacement = `(${toLabel})`;
			const localIndex = scopedText.indexOf(marker);
			attempt.searchText = marker;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;
			pushPatch({
				start: range.start + localIndex,
				end: range.start + localIndex + marker.length,
				deleted: marker,
				inserted: replacement,
			});
			break;
		}

		case UltimateEditKind.Move: {
			if (operation.resolvedMoveFromIds.length !== operation.edit.from.length) {
				break;
			}
			if (operation.resolvedMoveFromIds.some((value) => value === null)) break;
			const fromRanges = operation.resolvedMoveFromIds
				.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
				.filter((resolved): resolved is ScopeRange => resolved !== null)
				.map((resolved) => ({ start: resolved.start, end: resolved.end }));
			if (fromRanges.length !== operation.edit.from.length) break;
			fromRanges.sort((left, right) => left.start - right.start);
			const movedBlock = fromRanges
				.map((resolved) => plainText.slice(resolved.start, resolved.end).trim())
				.join("\n");
			if (movedBlock.length === 0) break;
			if (operation.resolvedMoveAnchorId === null) break;
			const anchorRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedMoveAnchorId,
			);
			if (!anchorRange) break;
			const originalInsertIndex = operation.edit.before
				? anchorRange.start
				: anchorRange.end;
			let textWithoutMoved = plainText;
			for (let index = fromRanges.length - 1; index >= 0; index -= 1) {
				const segment = fromRanges[index];
				if (!segment) continue;
				textWithoutMoved = `${textWithoutMoved.slice(0, segment.start)}${textWithoutMoved.slice(segment.end)}`;
			}
			let adjustedInsertIndex = originalInsertIndex;
			for (const segment of fromRanges) {
				if (
					segment.start < originalInsertIndex &&
					originalInsertIndex < segment.end
				) {
					adjustedInsertIndex = -1;
					break;
				}
				if (segment.end <= originalInsertIndex) {
					adjustedInsertIndex -= segment.end - segment.start;
				}
			}
			if (adjustedInsertIndex < 0) break;
			const beforeChar = textWithoutMoved[adjustedInsertIndex - 1] ?? "";
			const afterChar = textWithoutMoved[adjustedInsertIndex] ?? "";
			const prefix =
				adjustedInsertIndex === 0 || beforeChar === "\n" ? "" : "\n";
			const suffix =
				adjustedInsertIndex >= textWithoutMoved.length || afterChar === "\n"
					? ""
					: "\n";
			const movedText = `${textWithoutMoved.slice(0, adjustedInsertIndex)}${prefix}${movedBlock}${suffix}${textWithoutMoved.slice(adjustedInsertIndex)}`;
			pushPatch({
				start: 0,
				end: plainText.length,
				deleted: plainText,
				inserted: movedText,
			});
			break;
		}
	}

	return { patches, attempt };
}

export function planEdits(
	model: DocumentModel,
	operations: ResolvedInstructionOperation[],
): PlanEditsResult {
	const attempts: OperationMatchAttempt[] = [];
	const tentativePatches: PlannedPatch[] = [];

	for (const operation of operations) {
		const { patches, attempt } = planPatchForOperation(model, operation);
		attempts.push(attempt);
		tentativePatches.push(...patches);
	}

	const accepted: PlannedPatch[] = [];
	for (const patch of tentativePatches.sort(
		(left, right) =>
			left.operationIndex - right.operationIndex || left.start - right.start,
	)) {
		const hasConflict = accepted.some((existing) => overlaps(existing, patch));
		if (hasConflict) continue;
		accepted.push(patch);
	}

	const appliedCountByOperation = new Map<number, number>();
	for (const patch of accepted) {
		appliedCountByOperation.set(
			patch.operationIndex,
			(appliedCountByOperation.get(patch.operationIndex) ?? 0) + 1,
		);
	}
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		if (!attempt || attempt.outcome === "scope_unresolved") continue;
		const count = appliedCountByOperation.get(index) ?? 0;
		attempt.patchApplied = count > 0;
		attempt.outcome = count > 0 ? "applied" : "no_patch";
	}

	return {
		patches: accepted.sort(
			(left, right) =>
				left.operationIndex - right.operationIndex || left.start - right.start,
		),
		attempts,
	};
}
