import { getScopeRangeFromNodeId } from "./amendment-document-model";
import type {
	DocumentModel,
	OperationMatchAttempt,
	PlanEditsResult,
	PlannedPatch,
	ResolvedInstructionOperation,
	ScopeRange,
} from "./amendment-edit-engine-types";
import { PunctuationKind } from "./amendment-edit-tree";
import { formatInsertedBlockContent } from "./inserted-block-format";

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

function formatInsertionContent(content: string, targetLevel: number): string {
	return formatInsertedBlockContent(content, {
		baseDepth: targetLevel + 1,
		quotePlainMultiline: true,
	});
}

function formatReplacementContent(
	content: string,
	targetLevel: number,
): string {
	return formatInsertedBlockContent(content, {
		baseDepth: targetLevel,
		quotePlainMultiline: true,
	});
}

function ensureMultilineReplacementBoundary(
	inserted: string,
	sourceText: string,
	rangeEnd: number,
): string {
	if (!inserted.includes("\n")) return inserted;
	if (inserted.endsWith("\n")) return inserted;
	const nextChar = sourceText[rangeEnd] ?? "";
	if (nextChar.length === 0 || nextChar === "\n") return inserted;
	return `${inserted}\n`;
}

function formatBlockInsertionContent(
	content: string,
	targetLevel: number,
): string {
	return formatInsertedBlockContent(content, {
		baseDepth: targetLevel + 1,
		quotePlainMultiline: true,
	});
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
	const pattern = new RegExp(`${direction}\\s+["“”„‟'‘]([^"”'’]+)["”'’]`, "i");
	const match = nodeText.match(pattern);
	return match?.[1] ?? null;
}

function getOperationStrikingContent(
	operation: ResolvedInstructionOperation["operation"],
): string | null {
	if ("strikingContent" in operation) {
		return operation.strikingContent ?? null;
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

function buildAttempt(
	operation: ResolvedInstructionOperation,
	range: ScopeRange | null,
	sourceText: string,
): OperationMatchAttempt {
	return {
		operationType: operation.operation.type,
		nodeText: operation.nodeText,
		strikingContent: getOperationStrikingContent(operation.operation),
		targetPath: operation.targetPathText,
		hasExplicitTargetPath: operation.hasExplicitTargetPath,
		scopedRange: range
			? {
					start: range.start,
					end: range.end,
					length: range.end - range.start,
					preview: previewRange(sourceText, range),
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
	sourceText: string,
	operation: ResolvedInstructionOperation,
): { patches: PlannedPatch[]; attempt: OperationMatchAttempt } {
	const baseRange = getScopeRangeFromNodeId(model, operation.resolvedTargetId);
	let range = baseRange;
	const attempt = buildAttempt(operation, range, sourceText);

	if (operation.hasExplicitTargetPath && !operation.resolvedTargetId) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}
	if (!range) {
		attempt.outcome = "scope_unresolved";
		return { patches: [], attempt };
	}

	const hasMatterPrecedingTarget =
		"matterPrecedingTarget" in operation.operation &&
		Boolean(operation.operation.matterPrecedingTarget);
	if (hasMatterPrecedingTarget) {
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
		range = {
			...range,
			end: Math.max(range.start, boundary),
		};
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(sourceText, range),
		};
	}

	const hasMatterFollowingTarget =
		"matterFollowingTarget" in operation.operation &&
		Boolean(operation.operation.matterFollowingTarget);
	if (hasMatterFollowingTarget) {
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
		range = {
			...range,
			start: Math.min(boundary, range.end),
		};
		attempt.scopedRange = {
			start: range.start,
			end: range.end,
			length: range.end - range.start,
			preview: previewRange(sourceText, range),
		};
	}

	const sentenceOrdinal =
		"sentenceOrdinal" in operation.operation
			? operation.operation.sentenceOrdinal
			: undefined;
	if (typeof sentenceOrdinal === "number") {
		const sentenceRange = resolveSentenceOrdinalRange(
			sourceText.slice(range.start, range.end),
			sentenceOrdinal,
		);
		if (sentenceRange) {
			range = {
				...range,
				start: range.start + sentenceRange.start,
				end: range.start + sentenceRange.end,
			};
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: range.end - range.start,
				preview: previewRange(sourceText, range),
			};
		} else {
			range = { ...range, start: range.end, end: range.end };
			attempt.scopedRange = {
				start: range.start,
				end: range.end,
				length: 0,
				preview: "",
			};
		}
	}

	const scopedText = sourceText.slice(range.start, range.end);
	const patches: PlannedPatch[] = [];

	switch (operation.operation.type) {
		case "replace": {
			const strikingContent = operation.operation.strikingContent;
			const replacementContent = operation.operation.content;
			const eachPlaceItAppears =
				operation.operation.eachPlaceItAppears === true;
			if (!replacementContent) break;
			if (!strikingContent) {
				if (
					operation.operation.throughTarget &&
					operation.resolvedThroughTargetId
				) {
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
						const inserted = ensureMultilineReplacementBoundary(
							formatReplacementContent(
								replacementContent,
								range.targetLevel ?? 0,
							),
							sourceText,
							range.end,
						);
						patches.push({
							operationIndex: operation.operationIndex,
							start: range.start,
							end: range.end,
							deleted: scopedText,
							inserted,
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					const inserted = ensureMultilineReplacementBoundary(
						formatReplacementContent(
							replacementContent,
							range.targetLevel ?? 0,
						),
						sourceText,
						end,
					);
					patches.push({
						operationIndex: operation.operationIndex,
						start,
						end,
						deleted: sourceText.slice(start, end),
						inserted,
					});
					break;
				}
				const inserted = ensureMultilineReplacementBoundary(
					formatReplacementContent(replacementContent, range.targetLevel ?? 0),
					sourceText,
					range.end,
				);
				patches.push({
					operationIndex: operation.operationIndex,
					start: range.start,
					end: range.end,
					deleted: scopedText,
					inserted,
				});
				break;
			}

			const localIndex = scopedText.indexOf(strikingContent);
			attempt.searchText = strikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;

			if (eachPlaceItAppears) {
				const occurrenceIndexes = findAllOccurrences(
					scopedText,
					strikingContent,
				);
				for (const occurrenceIndex of occurrenceIndexes) {
					patches.push({
						operationIndex: operation.operationIndex,
						start: range.start + occurrenceIndex,
						end: range.start + occurrenceIndex + strikingContent.length,
						deleted: strikingContent,
						inserted: replacementContent,
					});
				}
				break;
			}

			patches.push({
				operationIndex: operation.operationIndex,
				start: range.start + localIndex,
				end: range.start + localIndex + strikingContent.length,
				deleted: strikingContent,
				inserted: replacementContent,
			});
			break;
		}
		case "delete": {
			const strikingContent = operation.operation.strikingContent;
			const eachPlaceItAppears =
				operation.operation.eachPlaceItAppears === true;
			if (!strikingContent) {
				if (
					operation.operation.throughTarget &&
					operation.resolvedThroughTargetId
				) {
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
						patches.push({
							operationIndex: operation.operationIndex,
							start: range.start,
							end: range.end,
							deleted: scopedText,
							inserted: "",
						});
						break;
					}
					const start = Math.min(range.start, throughRange.start);
					const end = Math.max(range.end, throughRange.end);
					patches.push({
						operationIndex: operation.operationIndex,
						start,
						end,
						deleted: sourceText.slice(start, end),
						inserted: "",
					});
					break;
				}
				patches.push({
					operationIndex: operation.operationIndex,
					start: range.start,
					end: range.end,
					deleted: scopedText,
					inserted: "",
				});
				break;
			}

			const localStart = scopedText.indexOf(strikingContent);
			attempt.searchText = strikingContent;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localStart >= 0 ? range.start + localStart : null;
			if (localStart < 0) break;

			if (
				eachPlaceItAppears &&
				!operation.operation.throughContent &&
				!operation.operation.throughPunctuation
			) {
				const occurrenceIndexes = findAllOccurrences(
					scopedText,
					strikingContent,
				);
				for (const occurrenceIndex of occurrenceIndexes) {
					patches.push({
						operationIndex: operation.operationIndex,
						start: range.start + occurrenceIndex,
						end: range.start + occurrenceIndex + strikingContent.length,
						deleted: strikingContent,
						inserted: "",
					});
				}
				break;
			}

			let localEnd = localStart + strikingContent.length;
			if (operation.operation.throughContent) {
				const throughStart = scopedText.indexOf(
					operation.operation.throughContent,
					localStart + strikingContent.length,
				);
				if (throughStart < 0) break;
				localEnd = throughStart + operation.operation.throughContent.length;
			}
			if (operation.operation.throughPunctuation) {
				const punctuation = punctuationText(
					operation.operation.throughPunctuation,
				);
				const punctuationIndex = scopedText.indexOf(
					punctuation,
					localStart + strikingContent.length,
				);
				if (punctuationIndex < 0) break;
				localEnd = punctuationIndex + punctuation.length;
			}

			let patchStart = range.start + localStart;
			let patchEnd = range.start + localEnd;
			if (
				operation.operation.throughContent ||
				operation.operation.throughPunctuation
			) {
				const beforeChar = sourceText[patchStart - 1] ?? "";
				const afterChar = sourceText[patchEnd] ?? "";
				if (patchStart === 0 && afterChar === " ") {
					patchEnd += 1;
				} else if (patchStart > 0 && beforeChar === " " && afterChar === " ") {
					patchStart -= 1;
				}
			}

			patches.push({
				operationIndex: operation.operationIndex,
				start: patchStart,
				end: patchEnd,
				deleted: sourceText.slice(patchStart, patchEnd),
				inserted: "",
			});
			break;
		}
		case "insert_before": {
			const anchor =
				operation.operation.anchorContent ??
				(operation.operation.anchorTarget
					? null
					: extractAnchor(operation.nodeText, "before"));
			const content = operation.operation.content;
			if (!content) break;

			let anchorStart: number | null = null;
			if (anchor) {
				const localIndex = scopedText.indexOf(anchor);
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_before";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex >= 0) anchorStart = range.start + localIndex;
			} else if (operation.resolvedAnchorTargetId !== null) {
				const anchorRange = getScopeRangeFromNodeId(
					model,
					operation.resolvedAnchorTargetId,
				);
				if (anchorRange) anchorStart = anchorRange.start;
			}

			if (anchorStart === null) break;
			const formatted = formatInsertionContent(content, range.targetLevel ?? 0);
			const value = anchor
				? `${formatted}${/[A-Za-z0-9)]$/.test(formatted) && /^[A-Za-z0-9(]/.test(anchor) ? " " : ""}`
				: `${formatted}${formatted.endsWith("\n") ? "" : "\n"}`;
			patches.push({
				operationIndex: operation.operationIndex,
				start: anchorStart,
				end: anchorStart,
				deleted: "",
				inserted: value,
			});
			break;
		}
		case "insert_after": {
			const anchor =
				operation.operation.anchorContent ??
				(operation.operation.anchorTarget
					? null
					: extractAnchor(operation.nodeText, "after"));
			const content = operation.operation.content;
			if (!content) break;

			let anchorEnd: number | null = null;
			if (anchor) {
				const localIndex = scopedText.indexOf(anchor);
				attempt.searchText = anchor;
				attempt.searchTextKind = "anchor_after";
				attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
				if (localIndex >= 0)
					anchorEnd = range.start + localIndex + anchor.length;
			} else if (operation.resolvedAnchorTargetId !== null) {
				const anchorRange = getScopeRangeFromNodeId(
					model,
					operation.resolvedAnchorTargetId,
				);
				if (anchorRange) anchorEnd = anchorRange.end;
			}

			if (anchorEnd === null) break;
			const formatted = formatInsertionContent(content, range.targetLevel ?? 0);
			const value = anchor
				? `${/[A-Za-z0-9)]$/.test(anchor) && /^[A-Za-z0-9(]/.test(formatted) ? " " : ""}${formatted}`
				: `${sourceText[anchorEnd - 1] === "\n" || anchorEnd === 0 ? "" : "\n"}${formatted}`;
			patches.push({
				operationIndex: operation.operationIndex,
				start: anchorEnd,
				end: anchorEnd,
				deleted: "",
				inserted: value,
			});
			break;
		}
		case "insert": {
			const content = operation.operation.content;
			if (!content) break;
			const insertAt = range.end;
			const beforeChar = sourceText[insertAt - 1] ?? "";
			const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
			const formatted = formatInsertionContent(content, range.targetLevel ?? 0);
			patches.push({
				operationIndex: operation.operationIndex,
				start: insertAt,
				end: insertAt,
				deleted: "",
				inserted: `${prefix}${formatted}`,
			});
			break;
		}
		case "add_at_end": {
			const content = operation.operation.content;
			if (!content) break;
			const insertAt = range.end;
			const beforeChar = sourceText[insertAt - 1] ?? "";
			const afterChar = sourceText[insertAt] ?? "";
			const prefix = beforeChar === "\n" || insertAt === 0 ? "" : "\n";
			const formatted = formatBlockInsertionContent(
				content,
				range.targetLevel ?? 0,
			);
			const suffix = afterChar && afterChar !== "\n" ? "\n\n" : "\n";
			patches.push({
				operationIndex: operation.operationIndex,
				start: insertAt,
				end: insertAt,
				deleted: "",
				inserted: `${prefix}${formatted}${suffix}`,
			});
			break;
		}
		case "redesignate": {
			const marker = `(${operation.operation.fromLabel})`;
			const replacement = `(${operation.operation.toLabel})`;
			const localIndex = scopedText.indexOf(marker);
			attempt.searchText = marker;
			attempt.searchTextKind = "striking";
			attempt.searchIndex = localIndex >= 0 ? range.start + localIndex : null;
			if (localIndex < 0) break;
			patches.push({
				operationIndex: operation.operationIndex,
				start: range.start + localIndex,
				end: range.start + localIndex + marker.length,
				deleted: marker,
				inserted: replacement,
			});
			break;
		}
		case "move": {
			if (
				operation.resolvedMoveFromIds.length !==
				operation.operation.fromTargets.length
			) {
				break;
			}
			if (operation.resolvedMoveFromIds.some((value) => value === null)) break;
			const fromRanges = operation.resolvedMoveFromIds
				.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
				.filter((resolved): resolved is ScopeRange => resolved !== null)
				.map((resolved) => ({ start: resolved.start, end: resolved.end }));
			if (fromRanges.length !== operation.operation.fromTargets.length) break;
			fromRanges.sort((left, right) => left.start - right.start);
			const movedBlock = fromRanges
				.map((resolved) =>
					sourceText.slice(resolved.start, resolved.end).trim(),
				)
				.join("\n");
			if (movedBlock.length === 0) break;
			if (operation.resolvedMoveAnchorId === null) break;
			const anchorRange = getScopeRangeFromNodeId(
				model,
				operation.resolvedMoveAnchorId,
			);
			if (!anchorRange) break;
			const originalInsertIndex = operation.operation.beforeTarget
				? anchorRange.start
				: anchorRange.end;
			let textWithoutMoved = sourceText;
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
			patches.push({
				operationIndex: operation.operationIndex,
				start: 0,
				end: sourceText.length,
				deleted: sourceText,
				inserted: movedText,
			});
			break;
		}
	}

	return { patches, attempt };
}

export function planEdits(
	model: DocumentModel,
	sourceText: string,
	operations: ResolvedInstructionOperation[],
): PlanEditsResult {
	const attempts: OperationMatchAttempt[] = [];
	const tentativePatches: PlannedPatch[] = [];

	for (const operation of operations) {
		const { patches, attempt } = planPatchForOperation(
			model,
			sourceText,
			operation,
		);
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
