import type { Env, IngestionResult, ParsedSection } from "../../types";
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

/**
 * Normalize a compound ID like "04-125" -> "4-125" or "01a-200" -> "1a-200"
 */
function normalizeCompoundId(id: string): string {
	return id
		.split("-")
		.map((part) => normalizeDesignator(part) || part)
		.join("-");
}

/**
 * Parse a section label like "Sec. 4-125. Title of section." into parts
 * Returns the section number and the clean title (no trailing period)
 */
function parseSectionLabel(label: string): {
	sectionNumber: string | null;
	title: string | null;
} {
	// Match patterns like:
	// "Sec. 4-125. Title of section."
	// "Secs. 4-125 to 4-130. Title of section range."
	const match = label.match(/^Secs?\.\s+([^.]+)\.\s*(.*)$/);
	if (!match) {
		return { sectionNumber: null, title: label.replace(/\.$/, "").trim() };
	}

	const sectionNumber = match[1].trim();
	let title = match[2].trim();

	// Remove trailing period from title
	title = title.replace(/\.$/, "").trim();

	return {
		sectionNumber,
		title: title || null,
	};
}

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";

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
	const result = await crawlCGA(startUrl, env.GODADDY_CA, 2000, 0, 20);
	console.log(
		`Crawled ${result.titles.size} titles, ${result.chapters.size} chapters, ${result.sections.length} sections`,
	);

	const titles = result.titles;
	const chapters = result.chapters;

	// Convert crawled sections to ParsedSection format with parentStringId
	const allSections: ParsedSection[] = [];
	for (const section of result.sections) {
		// Find chapter info to get chapterId
		let chapterId: string | null = null;
		for (const [chapId, chapter] of chapters.entries()) {
			if (chapter.sourceUrl === section.sourceUrl) {
				chapterId = chapId;
				break;
			}
		}

		// Normalize section ID (strip leading zeros from numeric parts, no sec_ prefix)
		const rawSectionNum = section.sectionId.replace(/^sec[s]?_/, "");
		const normalizedSectionNum = normalizeCompoundId(rawSectionNum);
		const normalizedChapterNum = chapterId
			? normalizeDesignator(chapterId.replace("chap_", "")) ||
				chapterId.replace("chap_", "")
			: null;

		// Parse label to extract section number and clean title
		const { title: cleanTitle } = parseSectionLabel(section.label);

		allSections.push({
			stringId: `cgs/section/${normalizedSectionNum}`,
			levelName: "section",
			levelIndex: 2,
			name: cleanTitle,
			path: `/statutes/cgs/section/${normalizedSectionNum}`,
			readableId: normalizedSectionNum,
			body: section.body,
			historyShort: section.historyShort,
			historyLong: section.historyLong,
			citations: section.citations,
			parentStringId: normalizedChapterNum
				? `cgs/chapter/${normalizedChapterNum}`
				: null,
			sortOrder: 0,
			sourceUrl: section.sourceUrl,
		});
	}

	console.log(
		`Found ${titles.size} titles, ${chapters.size} chapters, ${allSections.length} sections`,
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

	for (let i = 0; i < sortedTitles.length; i++) {
		const title = sortedTitles[i];
		const normalizedTitleId =
			normalizeDesignator(title.titleId) || title.titleId;
		const stringId = `cgs/title/${normalizedTitleId}`;
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

	for (let i = 0; i < sortedChapters.length; i++) {
		const chapter = sortedChapters[i];
		const normalizedTitleId =
			normalizeDesignator(chapter.titleId) || chapter.titleId;
		const titleStringId = `cgs/title/${normalizedTitleId}`;
		const parentId = nodeIdMap.get(titleStringId) || null;

		const chapterNum = chapter.chapterId.replace("chap_", "");
		const normalizedChapterNum = normalizeDesignator(chapterNum) || chapterNum;
		const stringId = `cgs/chapter/${normalizedChapterNum}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			"chapter",
			1,
			i,
			chapter.chapterTitle,
			`/statutes/cgs/chapter/${normalizedTitleId}/${normalizedChapterNum}`,
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

	for (let i = 0; i < allSections.length; i++) {
		const section = allSections[i];

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
								label: "History",
								content: section.historyShort,
							},
						]
					: []),
				...(section.historyLong
					? [
							{
								type: "history_long",
								label: "History Notes",
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
