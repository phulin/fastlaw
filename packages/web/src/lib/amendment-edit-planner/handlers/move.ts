import { getScopeRangeFromNodeId } from "../../amendment-document-model";
import type {
	CanonicalDocument,
	ResolvedInstructionOperation,
	ScopeRange,
} from "../../amendment-edit-engine-types";

interface PushPatchArgs {
	start: number;
	end: number;
	deleted: string;
	inserted?: string;
	insertedPrefixPlain?: string;
	insertedSuffixPlain?: string;
	insertAt?: number;
}

interface MoveHandlerArgs {
	model: CanonicalDocument;
	operation: ResolvedInstructionOperation;
	plainText: string;
	pushPatch: (args: PushPatchArgs) => void;
}

export function handleMoveEdit(args: MoveHandlerArgs): void {
	const { model, operation, plainText, pushPatch } = args;
	if (operation.edit.kind !== "move") return;
	if (operation.resolvedMoveFromIds.length !== operation.edit.from.length)
		return;
	if (operation.resolvedMoveFromIds.some((value) => value === null)) return;

	const fromRanges = operation.resolvedMoveFromIds
		.map((nodeId) => getScopeRangeFromNodeId(model, nodeId))
		.filter((resolved): resolved is ScopeRange => resolved !== null)
		.map((resolved) => ({ start: resolved.start, end: resolved.end }));
	if (fromRanges.length !== operation.edit.from.length) return;

	fromRanges.sort((left, right) => left.start - right.start);
	const movedBlock = fromRanges
		.map((resolved) => plainText.slice(resolved.start, resolved.end).trim())
		.join("\n");
	if (movedBlock.length === 0) return;
	if (operation.resolvedMoveAnchorId === null) return;

	const anchorRange = getScopeRangeFromNodeId(
		model,
		operation.resolvedMoveAnchorId,
	);
	if (!anchorRange) return;

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
	if (adjustedInsertIndex < 0) return;

	const beforeChar = textWithoutMoved[adjustedInsertIndex - 1] ?? "";
	const afterChar = textWithoutMoved[adjustedInsertIndex] ?? "";
	const prefix = adjustedInsertIndex === 0 || beforeChar === "\n" ? "" : "\n";
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
}
