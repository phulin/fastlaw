import type { PageItem } from "../../components/PageRow";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { buildCanonicalDocument } from "../amendment-document-model";
import type {
	CanonicalDocument,
	ClassificationOverride,
} from "../amendment-edit-engine-types";
import {
	type AmendmentEffect,
	applyAmendmentEditTreeToSection,
} from "../amendment-edit-tree-apply";
import type { NodeContent, Paragraph } from "../types";
import {
	discoverParsedInstructionSpans,
	discoverTitleScopedCodeReferenceDefaults,
	formatTargetScopePath,
	getSectionBodyText,
	getUscCitationFromScopePath,
	getUscSectionPathFromScopePath,
} from "./instruction-utils";

interface MutableCache<K, V> {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
}

export interface AmendmentPipelineCaches {
	canonicalDocumentBySectionKey?: MutableCache<string, CanonicalDocument>;
	amendmentEffectByInstructionKey?: MutableCache<string, AmendmentEffect>;
}

export interface AmendmentPipelinePerfStats {
	applyCallCount: number;
	applyTotalMs: number;
	canonicalCacheHits: number;
	canonicalCacheMisses: number;
	effectCacheHits: number;
	effectCacheMisses: number;
}

interface BuildPageItemsOptions {
	paragraphs: Paragraph[];
	sectionBodyCache: Map<string, NodeContent>;
	sourceVersionId: string;
	numAmendColors: number;
	fetchSectionBodies: (
		paths: string[],
		sourceVersionId?: string,
	) => Promise<Map<string, NodeContent>>;
	classificationOverrides?: ClassificationOverride[];
	caches?: AmendmentPipelineCaches;
	perfStats?: AmendmentPipelinePerfStats;
}

const buildUnsupportedEffect = (
	sectionPath: string,
	sectionBodyText: string,
): AmendmentEffect => {
	return {
		status: "unsupported",
		sectionPath,
		renderModel: { plainText: sectionBodyText, spans: [] },
		segments: [{ kind: "unchanged", text: sectionBodyText }],
		changes: [],
		deleted: [],
		inserted: [],
		applySummary: {
			partiallyApplied: false,
			failedItems: [],
			wasTranslated: false,
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

const normalizeInstructionText = (value: string): string =>
	value.replace(/\s+/g, " ").trim();

const sectionKeyForCache = (
	sectionPath: string,
	sectionBodyText: string,
): string => `${sectionPath}\u0000${sectionBodyText}`;

const instructionKeyForCache = (args: {
	sectionPath: string;
	basePlainText: string;
	instructionText: string;
	treeSignature: string;
	sourceVersionId: string;
}): string =>
	`${args.sectionPath}\u0000${args.basePlainText}\u0000${normalizeInstructionText(args.instructionText)}\u0000${args.treeSignature}\u0000${args.sourceVersionId}`;

export const buildPageItemsFromParagraphs = async ({
	paragraphs,
	sectionBodyCache,
	sourceVersionId,
	numAmendColors,
	fetchSectionBodies,
	classificationOverrides,
	caches,
	perfStats,
}: BuildPageItemsOptions): Promise<
	{ item: PageItem; pageNumber: number }[]
> => {
	const instructionSpans = discoverParsedInstructionSpans(paragraphs);
	const defaultCodeReferenceByParagraph =
		discoverTitleScopedCodeReferenceDefaults(paragraphs);
	const sectionPathByInstructionIndex = new Map<number, string>();
	const instructionCountBySectionPath = new Map<string, number>();
	const unresolvedPaths: string[] = [];
	const translatedEditTreeByInstructionIndex = new Map<
		number,
		ReturnType<typeof translateInstructionAstToEditTree>
	>();
	const treeSignatureByInstructionIndex = new Map<number, string>();

	for (const [index, span] of instructionSpans.entries()) {
		const fallbackCodeReferenceLabel = defaultCodeReferenceByParagraph.get(
			span.startParagraphIndex,
		);
		const translatedEditTree = translateInstructionAstToEditTree(
			span.parsedInstruction.ast,
			fallbackCodeReferenceLabel
				? {
						fallbackCodeReference: {
							kind: "code_reference",
							label: fallbackCodeReferenceLabel,
						},
					}
				: undefined,
		);
		translatedEditTreeByInstructionIndex.set(index, translatedEditTree);
		treeSignatureByInstructionIndex.set(
			index,
			JSON.stringify(translatedEditTree.tree),
		);
		const sectionPath = getUscSectionPathFromScopePath(
			translatedEditTree.tree.targetScopePath,
		);
		if (!sectionPath) continue;
		sectionPathByInstructionIndex.set(index, sectionPath);
		instructionCountBySectionPath.set(
			sectionPath,
			(instructionCountBySectionPath.get(sectionPath) ?? 0) + 1,
		);
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

	const sectionBodyTextByPath = new Map<string, string>();
	const getSectionBodyTextByPath = (sectionPath: string): string => {
		const cached = sectionBodyTextByPath.get(sectionPath);
		if (cached !== undefined) return cached;
		const resolved = getSectionBodyText(sectionBodyCache.get(sectionPath));
		sectionBodyTextByPath.set(sectionPath, resolved);
		return resolved;
	};

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

	// Tracks the latest post-amendment canonical document for each section, so
	// that multiple instructions targeting the same section apply on top of each
	// other in document order rather than each starting from the original text.
	const accumulatedDocBySectionPath = new Map<string, CanonicalDocument>();

	const pageItems: { item: PageItem; pageNumber: number }[] = [];
	for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
		if (instructionParagraphIndexes.has(paragraphIndex)) {
			const instructionIndex =
				instructionSpanByStartParagraph.get(paragraphIndex);
			if (instructionIndex === undefined) continue;
			const span = instructionSpans[instructionIndex];
			if (!span) continue;
			const firstParagraph = span.paragraphRange.paragraphs[0];
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
			const sectionBodyText = sectionPath
				? getSectionBodyTextByPath(sectionPath)
				: "";
			const instructionText = span.paragraphRange.paragraphs
				.map((instructionParagraph) => instructionParagraph.text)
				.join("\n");
			const splitLines = instructionText.split("\n");
			const uscCitation = translatedEditTree
				? getUscCitationFromScopePath(translatedEditTree.tree.targetScopePath)
				: null;
			let amendmentEffect: AmendmentEffect | null = null;
			if (sectionPath && sectionBodyText.length > 0 && translatedEditTree) {
				const treeSignature =
					treeSignatureByInstructionIndex.get(instructionIndex) ??
					JSON.stringify(translatedEditTree.tree);
				// Sections targeted by multiple instructions use the accumulated doc
				// as base, so their cache key must include the base text to stay
				// coherent. Single-instruction sections are unaffected.
				const hasMultipleInstructions =
					(instructionCountBySectionPath.get(sectionPath) ?? 0) > 1;
				const accumulatedDoc = accumulatedDocBySectionPath.get(sectionPath);
				const basePlainText = accumulatedDoc?.plainText ?? sectionBodyText;
				const instructionCacheKey = instructionKeyForCache({
					sectionPath,
					basePlainText,
					instructionText,
					treeSignature,
					sourceVersionId,
				});
				const cachedEffect =
					!hasMultipleInstructions || !accumulatedDoc
						? caches?.amendmentEffectByInstructionKey?.get(instructionCacheKey)
						: undefined;
				if (cachedEffect) {
					amendmentEffect = cachedEffect;
					if (perfStats) perfStats.effectCacheHits += 1;
				} else {
					if (perfStats) perfStats.effectCacheMisses += 1;
					let initialDocument: CanonicalDocument;
					if (accumulatedDoc) {
						initialDocument = accumulatedDoc;
					} else {
						const sectionCacheKey = sectionKeyForCache(
							sectionPath,
							sectionBodyText,
						);
						const cachedDoc =
							caches?.canonicalDocumentBySectionKey?.get(sectionCacheKey);
						if (cachedDoc) {
							initialDocument = cachedDoc;
							if (perfStats) perfStats.canonicalCacheHits += 1;
						} else {
							initialDocument = buildCanonicalDocument(sectionBodyText);
							caches?.canonicalDocumentBySectionKey?.set(
								sectionCacheKey,
								initialDocument,
							);
							if (perfStats) perfStats.canonicalCacheMisses += 1;
						}
					}

					const start = performance.now();
					amendmentEffect = applyAmendmentEditTreeToSection({
						tree: translatedEditTree.tree,
						sectionPath,
						sectionBody: basePlainText,
						initialDocument,
						instructionText,
						classificationOverrides,
					});
					if (perfStats) {
						perfStats.applyCallCount += 1;
						perfStats.applyTotalMs += performance.now() - start;
					}
					if (
						amendmentEffect.status === "ok" &&
						amendmentEffect.finalDocument
					) {
						accumulatedDocBySectionPath.set(
							sectionPath,
							amendmentEffect.finalDocument,
						);
					}
					if (!hasMultipleInstructions || !accumulatedDoc) {
						caches?.amendmentEffectByInstructionKey?.set(
							instructionCacheKey,
							amendmentEffect,
						);
					}
				}
			} else if (sectionPath && sectionBodyText.length > 0) {
				amendmentEffect = buildUnsupportedEffect(sectionPath, sectionBodyText);
			}
			const targetScopePath = translatedEditTree
				? formatTargetScopePath(translatedEditTree.tree.targetScopePath)
				: "";

			const paragraphs = span.paragraphRange.paragraphs;
			pageItems.push({
				item: {
					type: "instruction",
					instruction: {
						billSection: span.billSection,
						target: span.parsedInstruction.ast.parent.text,
						uscCitation,
						text: instructionText,
						paragraphs,
						startPage: firstParagraph.startPage,
						endPage:
							paragraphs[paragraphs.length - 1]?.endPage ??
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
