/**
 * CGA Cloudflare Workflow - hierarchical ingestion of Connecticut General Statutes
 *
 * Architecture:
 *   Root Step → Title Steps → Chapter Steps → Section Batch Steps → Finalize
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env, NodeInsert } from "../../types";
import { BlobStore } from "../packfile";
import {
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	insertNodesBatched,
	setRootNodeId,
} from "../versioning";
import { extractSectionCrossReferences } from "./cross-references";
import { normalizeDesignator } from "./parser";
import {
	buildSectionContent,
	designatorSortOrder,
	extractFilename,
	extractTitleUrls,
	extractVersionId,
	fetchWithCache,
	parseChapterPageForWorkflow,
	parseSectionsInRange,
	parseTitlePageForWorkflow,
} from "./workflow-helpers";
import type {
	CGAWorkflowParams,
	ChapterBatch,
	ChapterStepOutput,
	FinalizeOutput,
	RootStepOutput,
	SectionBatchItem,
	TitleStepOutput,
} from "./workflow-types";

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";

export class CGAIngestWorkflow extends WorkflowEntrypoint<
	Env,
	CGAWorkflowParams
> {
	async run(
		event: WorkflowEvent<CGAWorkflowParams>,
		step: WorkflowStep,
	): Promise<FinalizeOutput> {
		const { force = false } = event.payload;

		// ═══════════════════════════════════════════════════════════════
		// STEP 1: Root - fetch titles.htm, extract version, insert root
		// ═══════════════════════════════════════════════════════════════
		const root = await step.do("root", async (): Promise<RootStepOutput> => {
			const startUrl = `${this.env.CGA_BASE_URL}${this.env.CGA_START_PATH}`;

			// Fetch and parse root page to get version
			const response = await fetch(startUrl, {
				headers: {
					"User-Agent": "fastlaw-ingest/1.0",
					Accept: "text/html,application/xhtml+xml",
				},
			});
			if (!response.ok) {
				throw new Error(`Failed to fetch root page: ${response.status}`);
			}

			const html = await response.text();
			const versionId = extractVersionId(html); // e.g., "2025"
			const canonicalName = `cgs-${versionId}`; // e.g., "cgs-2025"

			// Check if version already exists
			const existingVersion = await this.env.DB.prepare(`
				SELECT id FROM source_versions
				WHERE canonical_name = ?
			`)
				.bind(canonicalName)
				.first<{ id: number }>();

			if (existingVersion && !force) {
				throw new Error(
					`Version ${canonicalName} already exists (id=${existingVersion.id}). Use force=true to re-ingest.`,
				);
			}

			// Get or create source
			const sourceId = await getOrCreateSource(
				this.env.DB,
				SOURCE_CODE,
				SOURCE_NAME,
				"state",
				"CT",
				"statute",
			);

			// Create source version (canonical_name = "cgs-2025" etc.)
			const sourceVersionId = await getOrCreateSourceVersion(
				this.env.DB,
				sourceId,
				versionId,
			);

			// Cache the root page
			await this.env.STORAGE.put(`sources/cga/${versionId}/titles.htm`, html, {
				httpMetadata: { contentType: "text/html" },
			});

			// Insert root node
			const accessedAt = new Date().toISOString();
			const rootNodeId = await insertNode(
				this.env.DB,
				sourceVersionId,
				"cgs/root",
				null,
				"root",
				-1,
				0,
				SOURCE_NAME,
				"/statutes/cgs",
				"CGS",
				"CGS",
				null,
				startUrl,
				accessedAt,
			);

			// Extract title URLs
			const titleUrls = extractTitleUrls(html, startUrl);

			console.log(
				`[CGA Workflow] Root step complete: version=${versionId}, titles=${titleUrls.length}`,
			);

			return {
				sourceVersionId,
				versionId,
				canonicalName,
				rootNodeId,
				titleUrls,
			};
		});

		// ═══════════════════════════════════════════════════════════════
		// STEP 2: Titles - process each title page
		// ═══════════════════════════════════════════════════════════════
		const titleResults: TitleStepOutput[] = [];

		for (const titleUrl of root.titleUrls) {
			const titleResult = await step.do(
				`title-${extractFilename(titleUrl)}`,
				async (): Promise<TitleStepOutput> => {
					const { body } = await fetchWithCache(
						titleUrl,
						root.versionId,
						this.env.STORAGE,
						this.env.GODADDY_CA,
					);

					const parsed = await parseTitlePageForWorkflow(body, titleUrl);
					const normalizedTitleId =
						normalizeDesignator(parsed.titleId) || parsed.titleId;
					const accessedAt = new Date().toISOString();

					// Insert title node
					const titleNodeId = await insertNode(
						this.env.DB,
						root.sourceVersionId,
						`cgs/title/${normalizedTitleId}`,
						root.rootNodeId,
						"title",
						0,
						designatorSortOrder(normalizedTitleId),
						parsed.titleName || `Title ${normalizedTitleId}`,
						`/statutes/cgs/title/${normalizedTitleId}`,
						normalizedTitleId,
						`Title ${normalizedTitleId}`,
						null,
						titleUrl,
						accessedAt,
					);

					console.log(
						`[CGA Workflow] Title step complete: ${normalizedTitleId}, chapters=${parsed.chapterUrls.length}`,
					);

					return {
						titleNodeId,
						titleId: normalizedTitleId,
						chapterUrls: parsed.chapterUrls,
					};
				},
			);

			titleResults.push(titleResult);
		}

		// ═══════════════════════════════════════════════════════════════
		// STEP 3: Chapters - process in batches of 20
		// ═══════════════════════════════════════════════════════════════
		const chapterResults: ChapterStepOutput[] = [];

		// Build chapter batches: group chapters with their parent title info
		const CHAPTER_BATCH_SIZE = 20;
		const chapterBatches: ChapterBatch[] = [];

		for (const title of titleResults) {
			for (let i = 0; i < title.chapterUrls.length; i += CHAPTER_BATCH_SIZE) {
				chapterBatches.push({
					titleNodeId: title.titleNodeId,
					titleId: title.titleId,
					chapters: title.chapterUrls.slice(i, i + CHAPTER_BATCH_SIZE),
				});
			}
		}

		for (let batchIndex = 0; batchIndex < chapterBatches.length; batchIndex++) {
			const batch = chapterBatches[batchIndex];

			const batchResults = await step.do(
				`chapters-batch-${batchIndex}`,
				async (): Promise<ChapterStepOutput[]> => {
					const results: ChapterStepOutput[] = [];

					for (const chapter of batch.chapters) {
						const { body } = await fetchWithCache(
							chapter.url,
							root.versionId,
							this.env.STORAGE,
							this.env.GODADDY_CA,
						);

						const parsed = await parseChapterPageForWorkflow(
							body,
							chapter.url,
							chapter.type,
						);
						const normalizedChapterId =
							normalizeDesignator(parsed.chapterId) || parsed.chapterId;
						const accessedAt = new Date().toISOString();
						const chapterType =
							chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);

						// Insert chapter node
						const chapterNodeId = await insertNode(
							this.env.DB,
							root.sourceVersionId,
							`cgs/${chapter.type}/${normalizedChapterId}`,
							batch.titleNodeId,
							chapter.type,
							1,
							designatorSortOrder(normalizedChapterId),
							parsed.chapterTitle,
							`/statutes/cgs/${chapter.type}/${batch.titleId}/${normalizedChapterId}`,
							normalizedChapterId,
							`${chapterType} ${normalizedChapterId}`,
							null,
							chapter.url,
							accessedAt,
						);

						const totalSections = parsed.sectionCount;

						console.log(
							`[CGA Workflow] Chapter processed: ${normalizedChapterId}, sections=${totalSections}`,
						);

						results.push({
							chapterNodeId,
							chapterId: normalizedChapterId,
							chapterUrl: chapter.url,
							totalSections,
						});
					}

					console.log(
						`[CGA Workflow] Chapter batch ${batchIndex} complete: ${results.length} chapters`,
					);

					return results;
				},
			);

			chapterResults.push(...batchResults);
		}

		// ═══════════════════════════════════════════════════════════════
		// STEP 4: Sections - batch across chapters, up to 200 per step
		// ═══════════════════════════════════════════════════════════════
		const SECTION_BATCH_SIZE = 200;
		const sectionBatches: SectionBatchItem[][] = [];
		let currentBatch: SectionBatchItem[] = [];
		let currentBatchSize = 0;

		for (const chapter of chapterResults) {
			let remaining = chapter.totalSections;
			let start = 0;

			while (remaining > 0) {
				const spaceInBatch = SECTION_BATCH_SIZE - currentBatchSize;
				const take = Math.min(remaining, spaceInBatch);

				currentBatch.push({
					chapterNodeId: chapter.chapterNodeId,
					chapterId: chapter.chapterId,
					chapterUrl: chapter.chapterUrl,
					startIndex: start,
					endIndex: start + take,
				});

				currentBatchSize += take;
				start += take;
				remaining -= take;

				if (currentBatchSize >= SECTION_BATCH_SIZE) {
					sectionBatches.push(currentBatch);
					currentBatch = [];
					currentBatchSize = 0;
				}
			}
		}
		if (currentBatch.length > 0) {
			sectionBatches.push(currentBatch);
		}

		let totalSectionsInserted = 0;

		for (let batchIndex = 0; batchIndex < sectionBatches.length; batchIndex++) {
			const batch = sectionBatches[batchIndex];

			const result = await step.do(`sections-batch-${batchIndex}`, async () => {
				const sourceIdResult = await this.env.DB.prepare(
					"SELECT id FROM sources WHERE code = ?",
				)
					.bind(SOURCE_CODE)
					.first<{ id: number }>();
				if (!sourceIdResult) {
					throw new Error("Source not found after creation");
				}
				const blobStore = new BlobStore(
					this.env.DB,
					this.env.STORAGE,
					sourceIdResult.id,
					SOURCE_CODE,
				);

				const nodes: NodeInsert[] = [];
				const sectionEntries: Array<{
					node: Omit<NodeInsert, "blob_hash">;
					content: unknown;
				}> = [];

				for (const item of batch) {
					const r2Key = `sources/cga/${root.versionId}/${extractFilename(item.chapterUrl)}`;
					const cached = await this.env.STORAGE.get(r2Key);
					if (!cached) {
						throw new Error(`Chapter HTML not found in cache: ${r2Key}`);
					}

					const html = await cached.text();
					const sections = await parseSectionsInRange(
						html,
						item.chapterUrl,
						item.startIndex,
						item.endIndex,
					);

					const accessedAt = new Date().toISOString();

					for (let i = 0; i < sections.length; i++) {
						const section = sections[i];

						const crossReferences = extractSectionCrossReferences(
							[section.body, section.seeAlso].filter(Boolean).join("\n"),
						);

						const content = buildSectionContent(section);
						if (crossReferences.length > 0) {
							(
								content as {
									metadata?: {
										cross_references: typeof crossReferences;
									};
								}
							).metadata = {
								cross_references: crossReferences,
							};
						}
						sectionEntries.push({
							content,
							node: {
								source_version_id: root.sourceVersionId,
								string_id: section.stringId,
								parent_id: item.chapterNodeId,
								level_name: "section",
								level_index: 2,
								sort_order: item.startIndex + i,
								name: section.name,
								path: section.path,
								readable_id: section.readableId,
								heading_citation: section.readableId
									? `CGS § ${section.readableId}`
									: null,
								source_url: item.chapterUrl,
								accessed_at: accessedAt,
							},
						});
					}
				}

				const blobHashes = await blobStore.storeJsonBatch(
					sectionEntries.map((entry) => entry.content),
				);
				for (let i = 0; i < sectionEntries.length; i++) {
					const entry = sectionEntries[i];
					nodes.push({
						...entry.node,
						blob_hash: blobHashes[i],
					});
				}

				await blobStore.flush();
				await insertNodesBatched(this.env.DB, nodes);

				return { insertedCount: nodes.length };
			});

			totalSectionsInserted += result.insertedCount;
		}

		// ═══════════════════════════════════════════════════════════════
		// STEP 5: Finalize - set root node
		// ═══════════════════════════════════════════════════════════════
		const finalResult = await step.do(
			"finalize",
			async (): Promise<FinalizeOutput> => {
				await setRootNodeId(this.env.DB, root.sourceVersionId, root.rootNodeId);

				console.log(
					`[CGA Workflow] Finalize complete: ${root.canonicalName}, titles=${titleResults.length}, chapters=${chapterResults.length}, sections=${totalSectionsInserted}`,
				);

				return {
					sourceVersionId: root.sourceVersionId,
					canonicalName: root.canonicalName,
					titlesProcessed: titleResults.length,
					chaptersProcessed: chapterResults.length,
					sectionsInserted: totalSectionsInserted,
				};
			},
		);

		return finalResult;
	}
}
