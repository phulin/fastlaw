import type { Env, IngestionResult } from "../../types";
import { NodeBatcher } from "../node-batcher";
import { BlobStore } from "../packfile";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "../versioning";
import { crawlCGA } from "./crawler";
import { extractSectionCrossReferences } from "./cross-references";
import { normalizeDesignator } from "./parser";

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";

async function withContext<T>(
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	try {
		return await action();
	} catch (error) {
		console.error(`[CGA] ${label} failed:`, error);
		throw error;
	}
}

/**
 * Main CGA ingestion function
 */
export async function ingestCGA(env: Env): Promise<IngestionResult> {
	const startUrl = `${env.CGA_BASE_URL}${env.CGA_START_PATH}`;
	const accessedAt = new Date().toISOString();

	// Get or create source
	const sourceId = await withContext("getOrCreateSource", () =>
		getOrCreateSource(
			env.DB,
			SOURCE_CODE,
			SOURCE_NAME,
			"state",
			"CT",
			"statute",
		),
	);

	// Get latest version for diff comparison
	const previousVersion = await withContext("getLatestVersion", () =>
		getLatestVersion(env.DB, sourceId),
	);

	// Create new version
	const versionDate = new Date().toISOString().split("T")[0];
	const versionId = await withContext("getOrCreateSourceVersion", () =>
		getOrCreateSourceVersion(env.DB, sourceId, versionDate),
	);

	// Insert nodes into database
	let nodesCreated = 0;
	const nodeIdMap = new Map<string, number>();

	// Initialize blob store for this source
	const blobStore = new BlobStore(env.DB, env.STORAGE, sourceId, SOURCE_CODE);

	// Insert root node for source
	const rootStringId = `cgs/root`;
	const rootNodeId = await withContext("insertNode(root)", () =>
		insertNode(
			env.DB,
			versionId,
			rootStringId,
			null,
			"root",
			-1,
			0,
			SOURCE_NAME,
			`/statutes/cgs`,
			"CGS", // readable_id for root
			"CGS", // heading_citation
			null,
			startUrl,
			accessedAt,
		),
	);
	nodeIdMap.set(rootStringId, rootNodeId);
	nodesCreated++;

	const seenTitleIds = new Set<string>();
	const seenChapterIds = new Set<string>();
	const seenSectionIds = new Set<string>();
	const sectionBatcher = new NodeBatcher(env.DB, 500, (nodeIdMapBatch) => {
		for (const [stringId, nodeId] of nodeIdMapBatch) {
			nodeIdMap.set(stringId, nodeId);
		}
		nodesCreated += nodeIdMapBatch.size;
	});

	const ensureTitleNode = async (
		titleId: string,
		titleName: string | null,
		sourceUrl: string,
	): Promise<number | null> => {
		const normalizedTitleId = normalizeDesignator(titleId) || titleId;
		const stringId = `cgs/title/${normalizedTitleId}`;
		const existing = nodeIdMap.get(stringId);
		if (existing) return existing;

		const sortOrder = designatorSortOrder(normalizedTitleId);
		const displayName = titleName || `Title ${normalizedTitleId}`;

		const nodeId = await withContext(`insertNode(title:${stringId})`, () =>
			insertNode(
				env.DB,
				versionId,
				stringId,
				rootNodeId,
				"title",
				0,
				sortOrder,
				displayName,
				`/statutes/cgs/title/${normalizedTitleId}`,
				normalizedTitleId,
				`Title ${normalizedTitleId}`,
				null,
				sourceUrl,
				accessedAt,
			),
		);

		nodeIdMap.set(stringId, nodeId);
		seenTitleIds.add(stringId);
		nodesCreated += 1;
		return nodeId;
	};

	const ensureChapterNode = async (chapter: {
		titleId: string;
		chapterId: string;
		chapterTitle: string | null;
		sourceUrl: string;
		type: "chapter" | "article";
	}): Promise<number | null> => {
		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const stringId = `cgs/${chapter.type}/${normalizedChapterNum}`;
		if (seenChapterIds.has(stringId)) {
			return nodeIdMap.get(stringId) ?? null;
		}

		const normalizedTitleId = normalizeDesignator(chapter.titleId);
		if (!normalizedTitleId) {
			return null;
		}

		const parentId = await ensureTitleNode(
			normalizedTitleId,
			null,
			chapter.sourceUrl,
		);
		const chapterType =
			chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);
		const headingCitation = `${chapterType} ${normalizedChapterNum}`;
		const sortOrder = designatorSortOrder(normalizedChapterNum);

		const nodeId = await withContext(
			`insertNode(${chapter.type}:${stringId})`,
			() =>
				insertNode(
					env.DB,
					versionId,
					stringId,
					parentId,
					chapter.type,
					1,
					sortOrder,
					chapter.chapterTitle,
					`/statutes/cgs/${chapter.type}/${normalizedTitleId}/${normalizedChapterNum}`,
					normalizedChapterNum,
					headingCitation,
					null,
					chapter.sourceUrl,
					accessedAt,
				),
		);

		nodeIdMap.set(stringId, nodeId);
		seenChapterIds.add(stringId);
		nodesCreated += 1;
		return nodeId;
	};

	let sectionSortOrder = 0;

	console.log(`Starting CGA crawl from ${startUrl}`);
	const result = await withContext("crawlCGA", () =>
		crawlCGA(
			startUrl,
			env.GODADDY_CA,
			{
				maxPages: 2000,
				concurrency: 20,
			},
			undefined,
			async (page) => {
				if (page.type === "title" && page.titleInfo) {
					const normalizedTitleId =
						normalizeDesignator(page.titleInfo.titleId) ||
						page.titleInfo.titleId;
					const titleStringId = `cgs/title/${normalizedTitleId}`;
					if (!seenTitleIds.has(titleStringId)) {
						await ensureTitleNode(
							page.titleInfo.titleId,
							page.titleInfo.titleName,
							page.titleInfo.sourceUrl,
						);
					}
					return;
				}

				if (
					(page.type === "chapter" || page.type === "article") &&
					page.chapterInfo
				) {
					await ensureChapterNode({
						titleId: page.chapterInfo.titleId,
						chapterId: page.chapterInfo.chapterId,
						chapterTitle: page.chapterInfo.chapterTitle,
						sourceUrl: page.chapterInfo.sourceUrl,
						type: page.chapterInfo.type,
					});
				}

				for (const section of page.sections) {
					if (seenSectionIds.has(section.stringId)) {
						console.log(
							`Skipping duplicate section: ${section.stringId} (sourceUrl: ${section.sourceUrl})`,
						);
						continue;
					}
					seenSectionIds.add(section.stringId);

					const parentId = section.parentStringId
						? nodeIdMap.get(section.parentStringId) || null
						: null;

					const crossReferences = extractSectionCrossReferences(
						[section.body, section.seeAlso].filter(Boolean).join("\n"),
					);

					const content = {
						blocks: [
							{ type: "body", content: section.body },
							...(section.historyShort
								? [
										{
											type: "history_short",
											label: "Short History",
											content: section.historyShort,
										},
									]
								: []),
							...(section.historyLong
								? [
										{
											type: "history_long",
											label: "Long History",
											content: section.historyLong,
										},
									]
								: []),
							...(section.citations
								? [
										{
											type: "citations",
											label: "Citations",
											content: section.citations,
										},
									]
								: []),
						],
						...(crossReferences.length > 0
							? { metadata: { cross_references: crossReferences } }
							: {}),
					};

					const blobHash = await blobStore.storeJson(content);

					const sectionHeadingCitation = section.readableId
						? `CGS § ${section.readableId}`
						: null;
					await sectionBatcher.add({
						source_version_id: versionId,
						string_id: section.stringId,
						parent_id: parentId,
						level_name: section.levelName,
						level_index: section.levelIndex,
						sort_order: sectionSortOrder++,
						name: section.name,
						path: section.path,
						readable_id: section.readableId,
						heading_citation: sectionHeadingCitation,
						blob_hash: blobHash,
						source_url: section.sourceUrl,
						accessed_at: accessedAt,
					});
				}
			},
		),
	);
	console.log(
		`Crawled ${result.titles.size} titles, ${result.chapters.size} chapters, ${result.sections.length} sections`,
	);

	console.log("Flushing section batches...");
	await withContext("insertNodesBatched", async () => {
		await sectionBatcher.flush();
	});

	// Flush any remaining blobs to packfiles
	await blobStore.flush();
	console.log("Flushed all blobs to storage.");

	// Set root node ID
	await withContext("setRootNodeId", () =>
		setRootNodeId(env.DB, versionId, rootNodeId),
	);
	console.log("Set root note ID.");

	// Compute diff if there was a previous version
	let diff = null;
	if (previousVersion) {
		console.log("Computing diff...");
		diff = await withContext("computeDiff", () =>
			computeDiff(env.DB, previousVersion.id, versionId),
		);
		console.log(
			`Diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.modified.length} modified`,
		);
	}

	console.log("Ingestion complete!");
	return {
		sourceVersionId: versionId,
		nodesCreated,
		diff,
	};
}

function designatorSortOrder(value: string): number {
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return Number.MAX_SAFE_INTEGER;
	const numeric = Number.parseInt(match[1], 10);
	const suffix = match[2].toLowerCase();
	let suffixValue = 0;
	for (const char of suffix) {
		const offset = char.charCodeAt(0) - 96;
		if (offset < 1 || offset > 26) return Number.MAX_SAFE_INTEGER;
		suffixValue = suffixValue * 27 + offset;
	}
	return numeric * 100000 + suffixValue;
}
