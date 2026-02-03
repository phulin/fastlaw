import type { Env, IngestionResult } from "../../types";
import { BlobStore } from "../packfile";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	insertNodesBatched,
	type NodeInsert,
	setRootNodeId,
} from "../versioning";
import { crawlCGA } from "./crawler";
import { extractSectionCrossReferences } from "./cross-references";
import { formatDesignatorPadded, normalizeDesignator } from "./parser";

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

	// Crawl CGA website - now returns structured data directly
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

	const titles = result.titles;
	const chapters = result.chapters;
	const chapterIdBySourceUrl = new Map<string, string>();
	for (const [id, chapter] of chapters.entries()) {
		chapterIdBySourceUrl.set(chapter.sourceUrl, id);
	}

	console.log(
		`Found ${titles.size} titles, ${chapters.size} chapters, ${result.sections.length} sections`,
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

	// Insert titles
	const sortedTitles = [...titles.values()].sort((a, b) => {
		const aPadded = formatDesignatorPadded(a.titleId) || a.titleId;
		const bPadded = formatDesignatorPadded(b.titleId) || b.titleId;
		return aPadded.localeCompare(bPadded);
	});

	const seenTitleIds = new Set<string>();
	for (let i = 0; i < sortedTitles.length; i++) {
		const title = sortedTitles[i];
		const normalizedTitleId =
			normalizeDesignator(title.titleId) || title.titleId;
		const stringId = `cgs/title/${normalizedTitleId}`;

		if (seenTitleIds.has(stringId)) {
			console.log(
				`Skipping duplicate title: ${stringId} (titleId: ${title.titleId}, sourceUrl: ${title.sourceUrl})`,
			);
			continue;
		}
		seenTitleIds.add(stringId);

		const nodeId = await withContext(`insertNode(title:${stringId})`, () =>
			insertNode(
				env.DB,
				versionId,
				stringId,
				rootNodeId,
				"title",
				0,
				i,
				title.titleName,
				`/statutes/cgs/title/${normalizedTitleId}`,
				normalizedTitleId, // readable_id
				`Title ${normalizedTitleId}`, // heading_citation
				null,
				title.sourceUrl,
				accessedAt,
			),
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert chapters
	const sortedChapters = [...chapters.values()].sort((a, b) => {
		const aKey = `${formatDesignatorPadded(a.titleId)}-${formatDesignatorPadded(a.chapterId.replace("chap_", ""))}`;
		const bKey = `${formatDesignatorPadded(b.titleId)}-${formatDesignatorPadded(b.chapterId.replace("chap_", ""))}`;
		return aKey.localeCompare(bKey);
	});

	const seenChapterIds = new Set<string>();
	for (let i = 0; i < sortedChapters.length; i++) {
		const chapter = sortedChapters[i];
		const normalizedTitleId =
			normalizeDesignator(chapter.titleId) || chapter.titleId;
		const titleStringId = `cgs/title/${normalizedTitleId}`;
		const parentId = nodeIdMap.get(titleStringId) || null;

		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const stringId = `cgs/${chapter.type}/${normalizedChapterNum}`;

		if (seenChapterIds.has(stringId)) {
			console.log(
				`Skipping duplicate ${chapter.type}: ${stringId} (raw chapterId: ${chapter.chapterId}, normalized: ${normalizedChapterNum}, titleId: ${chapter.titleId}, sourceUrl: ${chapter.sourceUrl})`,
			);
			continue;
		}
		seenChapterIds.add(stringId);
		console.log(
			`Adding ${chapter.type}: ${stringId} (raw chapterId: ${chapter.chapterId}, normalized: ${normalizedChapterNum})`,
		);

		// Generate heading_citation like "Chapter 410" or "Part 1"
		const chapterType =
			chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);
		const headingCitation = `${chapterType} ${normalizedChapterNum}`;

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
					i,
					chapter.chapterTitle,
					`/statutes/cgs/${chapter.type}/${normalizedTitleId}/${normalizedChapterNum}`,
					normalizedChapterNum, // readable_id
					headingCitation,
					null,
					chapter.sourceUrl,
					accessedAt,
				),
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Process sections: store content in R2 and prepare for batched insert
	// Track seen section stringIds to detect duplicates
	const seenSectionIds = new Set<string>();
	const sectionNodes: NodeInsert[] = [];

	console.log(`Processing ${result.sections.length} sections...`);
	for (let i = 0; i < result.sections.length; i++) {
		const section = result.sections[i];

		// Skip duplicate sections
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

		// Create content JSON
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

		// Store in packfile
		const blobHash = await blobStore.storeJson(content);

		// Collect node for batched insert
		// heading_citation for sections is "CGS § X" where X is the readable_id
		const sectionHeadingCitation = section.readableId
			? `CGS § ${section.readableId}`
			: null;
		sectionNodes.push({
			source_version_id: versionId,
			string_id: section.stringId,
			parent_id: parentId,
			level_name: section.levelName,
			level_index: section.levelIndex,
			sort_order: i,
			name: section.name,
			path: section.path,
			readable_id: section.readableId,
			heading_citation: sectionHeadingCitation,
			blob_hash: blobHash,
			source_url: section.sourceUrl,
			accessed_at: accessedAt,
		});

		if ((i + 1) % 1000 === 0) {
			console.log(`Processed ${i + 1}/${result.sections.length} sections...`);
		}
	}

	// Batch insert all section nodes
	console.log(`Inserting ${sectionNodes.length} section nodes in batches...`);
	const sectionNodeIds = await withContext("insertNodesBatched", () =>
		insertNodesBatched(env.DB, sectionNodes),
	);
	for (const [stringId, nodeId] of sectionNodeIds) {
		nodeIdMap.set(stringId, nodeId);
	}
	nodesCreated += sectionNodes.length;

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
