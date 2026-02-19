import type { PageItem } from "../../components/PageRow";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import {
	type AmendmentEffect,
	applyAmendmentEditTreeToSection,
} from "../amendment-edit-tree-apply";
import type { Paragraph } from "../text-extract";
import type { NodeContent } from "../types";
import {
	discoverParsedInstructionSpans,
	findBillSectionForInstruction,
	formatTargetScopePath,
	getSectionBodyText,
	getUscCitationFromScopePath,
	getUscSectionPathFromScopePath,
} from "./instruction-utils";

interface BuildPageItemsOptions {
	paragraphs: Paragraph[];
	sectionBodyCache: Map<string, NodeContent>;
	sourceVersionId: string;
	numAmendColors: number;
	fetchSectionBodies: (
		paths: string[],
		sourceVersionId?: string,
	) => Promise<Map<string, NodeContent>>;
}

const buildUnsupportedEffect = (
	sectionPath: string,
	sectionBodyText: string,
): AmendmentEffect => {
	return {
		status: "unsupported",
		sectionPath,
		segments: [{ kind: "unchanged", text: sectionBodyText }],
		changes: [],
		deleted: [],
		inserted: [],
		applySummary: {
			partiallyApplied: false,
			failedItems: [],
		},
		debug: {
			sectionTextLength: sectionBodyText.length,
			operationCount: 0,
			operationAttempts: [],
			failureReason: "instruction_parse_or_translate_failed",
			pipeline: {
				resolvedOperationCount: 0,
				plannedPatchCount: 0,
				resolutionIssueCount: 0,
				resolutionIssues: [],
			},
		},
	};
};

export const buildPageItemsFromParagraphs = async ({
	paragraphs,
	sectionBodyCache,
	sourceVersionId,
	numAmendColors,
	fetchSectionBodies,
}: BuildPageItemsOptions): Promise<
	{ item: PageItem; pageNumber: number }[]
> => {
	const instructionSpans = discoverParsedInstructionSpans(paragraphs);
	const sectionPathByInstructionIndex = new Map<number, string>();
	const unresolvedPaths: string[] = [];
	const translatedEditTreeByInstructionIndex = new Map<
		number,
		ReturnType<typeof translateInstructionAstToEditTree>
	>();

	for (const [index, span] of instructionSpans.entries()) {
		const translatedEditTree = translateInstructionAstToEditTree(
			span.parsedInstruction.ast,
		);
		translatedEditTreeByInstructionIndex.set(index, translatedEditTree);
		const sectionPath = getUscSectionPathFromScopePath(
			translatedEditTree.tree.targetScopePath,
		);
		if (!sectionPath) continue;
		sectionPathByInstructionIndex.set(index, sectionPath);
		if (!sectionBodyCache.has(sectionPath)) {
			unresolvedPaths.push(sectionPath);
		}
	}

	if (unresolvedPaths.length > 0) {
		const dedupedPaths = [...new Set(unresolvedPaths)];
		const fetched = await fetchSectionBodies(dedupedPaths, sourceVersionId);
		for (const [path, content] of fetched.entries()) {
			sectionBodyCache.set(path, content);
		}
	}

	const instructionSpanByStartParagraph = new Map<number, number>();
	const instructionParagraphIndexes = new Set<number>();
	for (const [index, span] of instructionSpans.entries()) {
		instructionSpanByStartParagraph.set(span.startParagraphIndex, index);
		for (
			let paragraphIndex = span.startParagraphIndex;
			paragraphIndex <= span.endParagraphIndex;
			paragraphIndex += 1
		) {
			instructionParagraphIndexes.add(paragraphIndex);
		}
	}

	const pageItems: { item: PageItem; pageNumber: number }[] = [];
	for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
		if (instructionParagraphIndexes.has(paragraphIndex)) {
			const instructionIndex =
				instructionSpanByStartParagraph.get(paragraphIndex);
			if (instructionIndex === undefined) continue;
			const span = instructionSpans[instructionIndex];
			if (!span) continue;
			const firstParagraph = span.paragraphs[0];
			if (!firstParagraph) continue;
			const topPercent = firstParagraph.pageHeight
				? ((firstParagraph.pageHeight - firstParagraph.y) /
						firstParagraph.pageHeight) *
					100
				: 0;
			const translatedEditTree =
				translatedEditTreeByInstructionIndex.get(instructionIndex) ?? null;
			const sectionPath =
				sectionPathByInstructionIndex.get(instructionIndex) ?? null;
			const sectionContent = sectionPath
				? sectionBodyCache.get(sectionPath)
				: undefined;
			const sectionBodyText = getSectionBodyText(sectionContent);
			const instructionText = span.paragraphs
				.map((instructionParagraph) => instructionParagraph.text)
				.join("\n");
			const splitLines = instructionText.split("\n");
			const uscCitation = translatedEditTree
				? getUscCitationFromScopePath(translatedEditTree.tree.targetScopePath)
				: null;
			const amendmentEffect =
				sectionPath && sectionBodyText.length > 0 && translatedEditTree
					? applyAmendmentEditTreeToSection({
							tree: translatedEditTree.tree,
							sectionPath,
							sectionBody: sectionBodyText,
							instructionText,
						})
					: sectionPath && sectionBodyText.length > 0
						? buildUnsupportedEffect(sectionPath, sectionBodyText)
						: null;
			const targetScopePath = translatedEditTree
				? formatTargetScopePath(translatedEditTree.tree.targetScopePath)
				: "";

			pageItems.push({
				item: {
					type: "instruction",
					instruction: {
						billSection: findBillSectionForInstruction(
							paragraphs,
							span.startParagraphIndex,
						),
						target: span.parsedInstruction.ast.parent.text,
						uscCitation,
						text: instructionText,
						paragraphs: span.paragraphs,
						startPage: firstParagraph.startPage,
						endPage:
							span.paragraphs[span.paragraphs.length - 1]?.endPage ??
							firstParagraph.endPage,
						targetScopePath,
					},
					amendmentEffect,
					sectionPath,
					workflowDebug: {
						sectionText: instructionText,
						splitLines,
						parsedInstruction: span.parsedInstruction,
						translatedEditTree,
					},
					colorIndex: instructionIndex % numAmendColors,
					topPercent,
				},
				pageNumber: firstParagraph.startPage,
			});
			continue;
		}

		const topPercent =
			paragraph.pageHeight > 0
				? ((paragraph.pageHeight - paragraph.yStart) / paragraph.pageHeight) *
					100
				: 0;
		pageItems.push({
			item: {
				type: "paragraph",
				text: paragraph.text,
				isBold: paragraph.isBold,
				colorIndex: null,
				level: paragraph.level ?? null,
				topPercent,
			},
			pageNumber: paragraph.startPage,
		});
	}

	return pageItems;
};
