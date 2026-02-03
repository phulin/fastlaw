import type { Env, IngestionResult } from "../../types";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "../versioning";
import { crawlCGA } from "./crawler";
import { formatDesignatorPadded, normalizeDesignator } from "./parser";

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";
const SECTION_NAME_TEMPLATE = "CGS § %ID%";

/**
 * Main CGA ingestion function
 */
export async function ingestCGA(env: Env): Promise<IngestionResult> {
	const startUrl = `${env.CGA_BASE_URL}${env.CGA_START_PATH}`;
	const accessedAt = new Date().toISOString();

	// Get or create source
	const sourceId = await getOrCreateSource(
		env.DB,
		SOURCE_CODE,
		SOURCE_NAME,
		"state",
		"CT",
		"statute",
		SECTION_NAME_TEMPLATE,
	);

	// Get latest version for diff comparison
	const previousVersion = await getLatestVersion(env.DB, sourceId);

	// Create new version
	const versionDate = new Date().toISOString().split("T")[0];
	const versionId = await getOrCreateSourceVersion(
		env.DB,
		sourceId,
		versionDate,
	);

	// Crawl CGA website - now returns structured data directly
	console.log(`Starting CGA crawl from ${startUrl}`);
	const result = await crawlCGA(startUrl, env.GODADDY_CA, {
		maxPages: 2000,
		concurrency: 20,
	});
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

	// Insert root node for source
	const rootStringId = `cgs/root`;
	const rootNodeId = await insertNode(
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
		null,
		null,
		null,
		startUrl,
		accessedAt,
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

		const nodeId = await insertNode(
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
			null,
			null,
			null,
			title.sourceUrl,
			accessedAt,
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

		const nodeId = await insertNode(
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
			null,
			null,
			null,
			chapter.sourceUrl,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert sections and store content in R2
	// Track seen section stringIds to detect duplicates
	const seenSectionIds = new Set<string>();

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

		// Create content JSON
		const content = {
			version: 2,
			doc_id: `doc_${section.stringId.replace(/\//g, "_")}`,
			doc_type: "statute",
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
		};

		// Store in R2
		const blobKey = `${section.path}.json`;
		const contentJson = JSON.stringify(content);
		const contentBytes = new TextEncoder().encode(contentJson);
		await env.STORAGE.put(blobKey, contentBytes);

		// Insert node with blob reference
		const nodeId = await insertNode(
			env.DB,
			versionId,
			section.stringId,
			parentId,
			section.levelName,
			section.levelIndex,
			i,
			section.name,
			section.path,
			section.readableId,
			blobKey,
			0,
			contentBytes.length,
			section.sourceUrl,
			accessedAt,
		);
		nodeIdMap.set(section.stringId, nodeId);
		nodesCreated++;

		if (nodesCreated % 100 === 0) {
			console.log(`Created ${nodesCreated} nodes...`);
		}
	}

	// Set root node ID
	await setRootNodeId(env.DB, versionId, rootNodeId);

	// Compute diff if there was a previous version
	let diff = null;
	if (previousVersion) {
		diff = await computeDiff(env.DB, previousVersion.id, versionId);
		console.log(
			`Diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.modified.length} modified`,
		);
	}

	return {
		sourceVersionId: versionId,
		nodesCreated,
		diff,
	};
}
