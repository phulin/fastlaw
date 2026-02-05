import type { Env, IngestionResult, IngestNode } from "../../types";
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

	// Initialize blob store for this source
	const blobStore = new BlobStore(env.DB, env.STORAGE, sourceId, SOURCE_CODE);

	// Insert root node for source
	const versionSegment = versionDate;
	const rootStringId = `cgs/${versionSegment}/root`;
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
	nodesCreated++;

	const seenSectionIds = new Set<string>();
	const sectionBatcher = new NodeBatcher(env.DB, 500, (nodeIdMapBatch) => {
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
	const titleNodes: IngestNode[] = titleRecords.map((record) => {
		const normalizedTitleId =
			normalizeDesignator(record.titleId) || record.titleId;
		const displayName = record.titleName || `Title ${normalizedTitleId}`;
		const titleStringId = `${rootStringId}/title-${normalizedTitleId}`;
		return {
			id: titleStringId,
			source_version_id: versionId,
			parent_id: rootStringId,
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
	nodesCreated += titleIdMap.size;

	const chapterNodes: IngestNode[] = buildChapterNodes(result.chapters, {
		accessedAt,
		versionId,
		rootStringId,
	});
	const chapterIdMap = await withContext("insertChapterNodes", () =>
		insertNodesBatched(env.DB, chapterNodes),
	);
	nodesCreated += chapterIdMap.size;

	let sectionSortOrder = 0;
	const chapterParentMap = buildChapterParentMap(result.chapters);
	for (const section of result.sections) {
		if (seenSectionIds.has(section.stringId)) {
			console.log(
				`Skipping duplicate section: ${section.stringId} (sourceUrl: ${section.sourceUrl})`,
			);
			continue;
		}
		seenSectionIds.add(section.stringId);

		const { parentId, sectionId } = resolveSectionParent({
			rootStringId,
			chapterParentMap,
			sectionParentStringId: section.parentStringId,
			sectionStringId: section.stringId,
		});

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
			id: sectionId,
			source_version_id: versionId,
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
		const normalizedTitleId =
			normalizeDesignator(titleInfo.titleId) || titleInfo.titleId;
		const existing = records.get(normalizedTitleId);
		if (existing) {
			if (!existing.titleName && titleInfo.titleName) {
				existing.titleName = titleInfo.titleName;
			}
			if (!existing.sourceUrl && titleInfo.sourceUrl) {
				existing.sourceUrl = titleInfo.sourceUrl;
			}
			continue;
		}
		records.set(normalizedTitleId, {
			titleId: normalizedTitleId,
			titleName: titleInfo.titleName,
			sourceUrl: titleInfo.sourceUrl,
		});
	}

	for (const chapterInfo of chapters.values()) {
		if (!chapterInfo.titleId) {
			continue;
		}
		const normalizedTitleId =
			normalizeDesignator(chapterInfo.titleId) || chapterInfo.titleId;
		const existing = records.get(normalizedTitleId);
		if (existing) {
			if (!existing.titleName && chapterInfo.sourceUrl) {
				existing.sourceUrl = chapterInfo.sourceUrl;
			}
			continue;
		}
		records.set(normalizedTitleId, {
			titleId: normalizedTitleId,
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
	context: { accessedAt: string; versionId: string; rootStringId: string },
): IngestNode[] {
	const nodes: IngestNode[] = [];

	for (const chapter of chapters.values()) {
		const normalizedTitleId = normalizeDesignator(chapter.titleId);
		if (!normalizedTitleId) {
			continue;
		}

		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const chapterType =
			chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);
		const titleStringId = `${context.rootStringId}/title-${normalizedTitleId}`;
		const chapterStringId = `${titleStringId}/${chapter.type}-${normalizedChapterNum}`;

		nodes.push({
			id: chapterStringId,
			source_version_id: context.versionId,
			parent_id: titleStringId,
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

type ChapterParentInfo = {
	titleId: string;
	chapterId: string;
	chapterType: "chapter" | "article";
};

function buildChapterParentMap(
	chapters: Map<string, ChapterInfo>,
): Map<string, ChapterParentInfo> {
	const map = new Map<string, ChapterParentInfo>();

	for (const chapter of chapters.values()) {
		const normalizedTitleId = normalizeDesignator(chapter.titleId);
		if (!normalizedTitleId) {
			continue;
		}
		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const key = `${chapter.type}:${normalizedChapterNum}`;
		map.set(key, {
			titleId: normalizedTitleId,
			chapterId: normalizedChapterNum,
			chapterType: chapter.type,
		});
	}

	return map;
}

function extractSectionSlug(sectionStringId: string): string {
	const parts = sectionStringId.split("/");
	return parts[parts.length - 1] || sectionStringId;
}

function resolveSectionParent(args: {
	rootStringId: string;
	chapterParentMap: Map<string, ChapterParentInfo>;
	sectionParentStringId: string | null;
	sectionStringId: string;
}): { parentId: string | null; sectionId: string } {
	const slug = extractSectionSlug(args.sectionStringId);

	if (!args.sectionParentStringId) {
		return {
			parentId: args.rootStringId,
			sectionId: `${args.rootStringId}/section-${slug}`,
		};
	}

	const parentParts = args.sectionParentStringId.split("/");
	const chapterType = parentParts[parentParts.length - 2] as
		| "chapter"
		| "article"
		| undefined;
	const chapterIdRaw = parentParts[parentParts.length - 1] || "";
	const normalizedChapterId = normalizeDesignator(chapterIdRaw) || chapterIdRaw;

	if (!chapterType) {
		throw new Error(`Invalid parent string id: ${args.sectionParentStringId}`);
	}

	const key = `${chapterType}:${normalizedChapterId}`;
	const match = args.chapterParentMap.get(key);
	if (!match) {
		throw new Error(`Missing chapter info for ${args.sectionParentStringId}`);
	}

	const parentId = `${args.rootStringId}/title-${match.titleId}/${match.chapterType}-${match.chapterId}`;
	return {
		parentId,
		sectionId: `${parentId}/section-${slug}`,
	};
}
