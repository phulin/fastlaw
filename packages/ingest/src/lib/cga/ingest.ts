import type { Env, IngestionResult, NodeInsert } from "../../types";
import { NodeBatcher } from "../node-batcher";
import { BlobStore } from "../packfile";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	insertNodesBatched,
	setRootNodeId,
} from "../versioning";
import { crawlCGA } from "./crawler";
import { extractSectionCrossReferences } from "./cross-references";
import {
	type ChapterInfo,
	normalizeDesignator,
	type TitleInfo,
} from "./parser";

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

	const seenSectionIds = new Set<string>();
	const sectionBatcher = new NodeBatcher(env.DB, 500, (nodeIdMapBatch) => {
		for (const [stringId, nodeId] of nodeIdMapBatch) {
			nodeIdMap.set(stringId, nodeId);
		}
		nodesCreated += nodeIdMapBatch.size;
	});
	console.log(`Starting CGA crawl from ${startUrl}`);
	const result = await withContext("crawlCGA", () =>
		crawlCGA(startUrl, env.GODADDY_CA, {
			maxPages: 2000,
			concurrency: 20,
		}),
	);
	console.log(
		`Crawled ${result.titles.size} titles, ${result.chapters.size} chapters, ${result.sections.length} sections`,
	);

	const titleRecords = buildTitleRecords(result.titles, result.chapters);
	const titleNodes: NodeInsert[] = titleRecords.map((record) => {
		const normalizedTitleId =
			normalizeDesignator(record.titleId) || record.titleId;
		const displayName = record.titleName || `Title ${normalizedTitleId}`;
		return {
			source_version_id: versionId,
			string_id: `cgs/title/${normalizedTitleId}`,
			parent_id: rootNodeId,
			level_name: "title",
			level_index: 0,
			sort_order: designatorSortOrder(normalizedTitleId),
			name: displayName,
			path: `/statutes/cgs/title/${normalizedTitleId}`,
			readable_id: normalizedTitleId,
			heading_citation: `Title ${normalizedTitleId}`,
			blob_hash: null,
			source_url: record.sourceUrl,
			accessed_at: accessedAt,
		};
	});

	const titleIdMap = await withContext("insertTitleNodes", () =>
		insertNodesBatched(env.DB, titleNodes),
	);
	for (const [stringId, nodeId] of titleIdMap) {
		nodeIdMap.set(stringId, nodeId);
	}
	nodesCreated += titleIdMap.size;

	const chapterNodes: NodeInsert[] = buildChapterNodes(
		result.chapters,
		nodeIdMap,
		{
			accessedAt,
			versionId,
		},
	);
	const chapterIdMap = await withContext("insertChapterNodes", () =>
		insertNodesBatched(env.DB, chapterNodes),
	);
	for (const [stringId, nodeId] of chapterIdMap) {
		nodeIdMap.set(stringId, nodeId);
	}
	nodesCreated += chapterIdMap.size;

	let sectionSortOrder = 0;
	for (const section of result.sections) {
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

interface TitleRecord {
	titleId: string;
	titleName: string | null;
	sourceUrl: string;
}

function buildTitleRecords(
	titles: Map<string, TitleInfo>,
	chapters: Map<string, ChapterInfo>,
): TitleRecord[] {
	const records = new Map<string, TitleRecord>();

	for (const titleInfo of titles.values()) {
		records.set(titleInfo.titleId, {
			titleId: titleInfo.titleId,
			titleName: titleInfo.titleName,
			sourceUrl: titleInfo.sourceUrl,
		});
	}

	for (const chapterInfo of chapters.values()) {
		if (!chapterInfo.titleId) {
			continue;
		}
		const existing = records.get(chapterInfo.titleId);
		if (existing) {
			if (!existing.titleName && chapterInfo.sourceUrl) {
				existing.sourceUrl = chapterInfo.sourceUrl;
			}
			continue;
		}
		records.set(chapterInfo.titleId, {
			titleId: chapterInfo.titleId,
			titleName: null,
			sourceUrl: chapterInfo.sourceUrl,
		});
	}

	return [...records.values()].sort((a, b) => {
		const aId = normalizeDesignator(a.titleId) || a.titleId;
		const bId = normalizeDesignator(b.titleId) || b.titleId;
		const diff = designatorSortOrder(aId) - designatorSortOrder(bId);
		return diff !== 0 ? diff : aId.localeCompare(bId);
	});
}

function buildChapterNodes(
	chapters: Map<string, ChapterInfo>,
	nodeIdMap: Map<string, number>,
	context: { accessedAt: string; versionId: number },
): NodeInsert[] {
	const nodes: NodeInsert[] = [];

	for (const chapter of chapters.values()) {
		const normalizedTitleId = normalizeDesignator(chapter.titleId);
		if (!normalizedTitleId) {
			continue;
		}

		const parentId = nodeIdMap.get(`cgs/title/${normalizedTitleId}`);
		if (!parentId) {
			throw new Error(`Missing title node for ${normalizedTitleId}`);
		}

		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const chapterType =
			chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);

		nodes.push({
			source_version_id: context.versionId,
			string_id: `cgs/${chapter.type}/${normalizedChapterNum}`,
			parent_id: parentId,
			level_name: chapter.type,
			level_index: 1,
			sort_order: designatorSortOrder(normalizedChapterNum),
			name: chapter.chapterTitle,
			path: `/statutes/cgs/${chapter.type}/${normalizedTitleId}/${normalizedChapterNum}`,
			readable_id: normalizedChapterNum,
			heading_citation: `${chapterType} ${normalizedChapterNum}`,
			blob_hash: null,
			source_url: chapter.sourceUrl,
			accessed_at: context.accessedAt,
		});
	}

	return nodes;
}
