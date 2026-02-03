import type { Env, IngestionResult } from "../../types";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "../versioning";
import {
	fetchAllUSCTitles,
	fetchUSCFromR2,
	getTitleNumFromUrl,
	getUSCTitleUrls,
} from "./fetcher";
import {
	chapterSortKey,
	parseUSCXml,
	sectionSortKey,
	titleSortKey,
} from "./parser";

const SOURCE_CODE = "usc";
const SOURCE_NAME = "United States Code";

interface USCSectionData {
	titleNum: string;
	chapterId: string | null;
	chapterHeading: string | null;
	sectionNum: string;
	heading: string;
	body: string;
	historyShort: string;
	historyLong: string;
	citations: string;
	path: string;
	docId: string;
	levelId: string;
	parentLevelId: string;
}

/**
 * Main USC ingestion function
 */
export async function ingestUSC(env: Env): Promise<IngestionResult> {
	const accessedAt = new Date().toISOString();

	// Get or create source
	const sourceId = await getOrCreateSource(
		env.DB,
		SOURCE_CODE,
		SOURCE_NAME,
		"federal",
		"US",
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

	// Try to fetch from R2 first (if pre-loaded), otherwise fetch from web
	console.log("Attempting to fetch USC XML from R2...");
	let xmlByTitle = await fetchUSCFromR2(env.STORAGE, "usc_raw/");

	if (xmlByTitle.size === 0) {
		console.log("No R2 data found, fetching from House OLRC...");
		// Fetch a limited number of titles to stay within Worker limits
		// For full ingestion, pre-load XML to R2
		xmlByTitle = await fetchAllUSCTitles(10, 200);
	}

	console.log(`Processing ${xmlByTitle.size} USC titles`);

	// Aggregated data
	const allTitles = new Map<string, string>();
	const allChapters = new Map<string, { titleNum: string; heading: string }>();
	const allSections: USCSectionData[] = [];

	// Parse each title XML
	for (const [titleNum, xml] of xmlByTitle) {
		const sourceUrl =
			getUSCTitleUrls().find((u) => getTitleNumFromUrl(u) === titleNum) || "";

		try {
			const { sections, titles, chapters } = parseUSCXml(
				xml,
				titleNum,
				sourceUrl,
			);

			// Merge titles
			for (const [t, name] of titles) {
				if (!allTitles.has(t)) {
					allTitles.set(t, name);
				}
			}

			// Merge chapters
			for (const [c, data] of chapters) {
				if (!allChapters.has(c)) {
					allChapters.set(c, data);
				}
			}

			// Add sections
			for (const section of sections) {
				allSections.push(section);
			}

			console.log(`  Title ${titleNum}: ${sections.length} sections`);
		} catch (error) {
			console.error(`Error parsing Title ${titleNum}:`, error);
		}
	}

	console.log(
		`Found ${allTitles.size} titles, ${allChapters.size} chapters, ${allSections.length} sections`,
	);

	// Insert nodes into database
	let nodesCreated = 0;
	const nodeIdMap = new Map<string, number>();

	// Insert root node
	const rootStringId = "usc/root";
	const rootNodeId = await insertNode(
		env.DB,
		versionId,
		rootStringId,
		null,
		"root",
		-1,
		0,
		SOURCE_NAME,
		`/statutes/usc`,
		"USC", // readable_id for root
		null,
		null,
		null,
		env.USC_DOWNLOAD_BASE,
		accessedAt,
	);
	nodeIdMap.set(rootStringId, rootNodeId);
	nodesCreated++;

	// Insert titles (sorted)
	const sortedTitles = [...allTitles.entries()].sort((a, b) => {
		const aKey = titleSortKey(a[0]);
		const bKey = titleSortKey(b[0]);
		return compareKeys(aKey, bKey);
	});

	for (let i = 0; i < sortedTitles.length; i++) {
		const [titleNum, titleName] = sortedTitles[i];
		const stringId = `usc/title/${titleNum}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			rootNodeId,
			"title",
			0,
			i,
			titleName,
			`/statutes/usc/title/${titleNum}`,
			titleNum, // readable_id
			null,
			null,
			null,
			`https://uscode.house.gov/download/releasepoints/us/pl/usc${titleNum.padStart(2, "0")}.xml`,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert chapters (sorted)
	const sortedChapters = [...allChapters.entries()].sort((a, b) => {
		const aKey = chapterSortKey(a[0]);
		const bKey = chapterSortKey(b[0]);
		return compareChapterKeys(aKey, bKey);
	});

	for (let i = 0; i < sortedChapters.length; i++) {
		const [chapterId, { titleNum, heading }] = sortedChapters[i];
		const titleStringId = `usc/title/${titleNum}`;
		const parentId = nodeIdMap.get(titleStringId) || null;

		const chapterNum = chapterId.includes("-")
			? chapterId.split("-")[1]
			: chapterId;
		const stringId = `usc/chapter/${chapterId}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			"chapter",
			1,
			i,
			heading,
			`/statutes/usc/chapter/${titleNum}/${chapterNum}`,
			chapterNum, // readable_id
			null,
			null,
			null,
			null,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert sections and store content in R2
	const sortedSections = allSections.sort((a, b) => {
		const aKey = [titleSortKey(a.titleNum), sectionSortKey(a.sectionNum)];
		const bKey = [titleSortKey(b.titleNum), sectionSortKey(b.sectionNum)];
		const titleCmp = compareKeys(aKey[0], bKey[0]);
		if (titleCmp !== 0) return titleCmp;
		return compareKeys(aKey[1], bKey[1]);
	});

	for (let i = 0; i < sortedSections.length; i++) {
		const section = sortedSections[i];

		// Determine parent
		let parentId: number | null = null;
		if (section.chapterId) {
			const chapterStringId = `usc/chapter/${section.chapterId}`;
			parentId = nodeIdMap.get(chapterStringId) || null;
		}
		if (!parentId) {
			const titleStringId = `usc/title/${section.titleNum}`;
			parentId = nodeIdMap.get(titleStringId) || null;
		}

		// Create content JSON
		const content = {
			version: 2,
			doc_id: section.docId,
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
					? [{ type: "citations", label: "Notes", content: section.citations }]
					: []),
			],
		};

		// Store in R2
		const blobKey = `${section.path}.json`;
		const contentJson = JSON.stringify(content);
		await env.STORAGE.put(blobKey, contentJson);

		// Insert node
		const stringId = `usc/section/${section.titleNum}-${section.sectionNum}`;
		const readableId = `${section.titleNum} USC ${section.sectionNum}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			"section",
			2,
			i,
			section.heading,
			section.path,
			readableId,
			blobKey,
			0,
			contentJson.length,
			null,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
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

// Helper comparison functions for sorting
function compareKeys(
	a: [number, [number, string] | string],
	b: [number, [number, string] | string],
): number {
	if (a[0] !== b[0]) return a[0] - b[0];

	const aVal = a[1];
	const bVal = b[1];

	if (typeof aVal === "string" && typeof bVal === "string") {
		return aVal.localeCompare(bVal);
	}

	if (Array.isArray(aVal) && Array.isArray(bVal)) {
		if (aVal[0] !== bVal[0]) return aVal[0] - bVal[0];
		return aVal[1].localeCompare(bVal[1]);
	}

	return 0;
}

function compareChapterKeys(
	a: [[number, [number, string] | string], [number, [number, string] | string]],
	b: [[number, [number, string] | string], [number, [number, string] | string]],
): number {
	const titleCmp = compareKeys(a[0], b[0]);
	if (titleCmp !== 0) return titleCmp;
	return compareKeys(a[1], b[1]);
}
