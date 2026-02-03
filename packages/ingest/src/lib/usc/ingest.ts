import type { Env, IngestionResult } from "../../types";
import { BlobStore } from "../packfile";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "../versioning";
import { extractSectionCrossReferences } from "./cross-references";
import {
	fetchAllUSCTitles,
	fetchUSCFromR2,
	getTitleNumFromUrl,
	getUSCTitleUrls,
} from "./fetcher";
import {
	levelSortKey,
	parseUSCXml,
	sectionSortKey,
	titleSortKey,
	USC_LEVEL_INDEX,
	type USCLevel,
} from "./parser";

const SOURCE_CODE = "usc";
const SOURCE_NAME = "United States Code";

/** Section level index is one higher than the highest organizational level */
const SECTION_LEVEL_INDEX = Object.keys(USC_LEVEL_INDEX).length;

interface USCSectionData {
	titleNum: string;
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
	const titleUrls = await getUSCTitleUrls();
	const titleUrlByNum = new Map<string, string>();

	for (const url of titleUrls) {
		const titleNum = getTitleNumFromUrl(url);
		if (titleNum) {
			titleUrlByNum.set(titleNum, url);
		}
	}

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
	const allLevels: USCLevel[] = [];
	const seenLevelIds = new Set<string>();
	const allSections: USCSectionData[] = [];

	// Parse each title XML
	for (const [titleNum, xml] of xmlByTitle) {
		const sourceUrl = titleUrlByNum.get(titleNum) ?? "";

		try {
			const result = parseUSCXml(xml, titleNum, sourceUrl);

			// Add title
			if (!allTitles.has(result.titleNum)) {
				allTitles.set(result.titleNum, result.titleName);
			}

			// Add levels (deduplicated)
			for (const level of result.levels) {
				if (!seenLevelIds.has(level.identifier)) {
					seenLevelIds.add(level.identifier);
					allLevels.push(level);
				}
			}

			// Add sections
			for (const section of result.sections) {
				allSections.push(section);
			}

			console.log(
				`  Title ${titleNum}: ${result.levels.length} levels, ${result.sections.length} sections`,
			);
		} catch (error) {
			console.error(`Error parsing Title ${titleNum}:`, error);
		}
	}

	console.log(
		`Found ${allTitles.size} titles, ${allLevels.length} organizational levels, ${allSections.length} sections`,
	);

	// Insert nodes into database
	let nodesCreated = 0;
	const nodeIdMap = new Map<string, number>();

	// Initialize blob store for this source
	const blobStore = new BlobStore(env.DB, env.STORAGE, SOURCE_CODE);

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
		"USC", // heading_citation
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
			`Title ${titleNum}`, // heading_citation
			null,
			titleUrlByNum.get(titleNum) ?? "",
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert organizational levels (sorted by title, level index, then number)
	const sortedLevels = [...allLevels].sort((a, b) => {
		const aKey = levelSortKey(a);
		const bKey = levelSortKey(b);
		return compareLevelKeys(aKey, bKey);
	});

	// First pass: create identifier to level mapping for parent lookups
	const levelByIdentifier = new Map<string, USCLevel>();
	for (const level of sortedLevels) {
		levelByIdentifier.set(level.identifier, level);
	}

	for (let i = 0; i < sortedLevels.length; i++) {
		const level = sortedLevels[i];
		const stringId = `usc/${level.levelType}/${level.identifier}`;

		// Determine parent node ID
		let parentId: number | null = null;
		if (level.parentIdentifier) {
			// Check if parent is another level
			const parentLevel = levelByIdentifier.get(level.parentIdentifier);
			if (parentLevel) {
				const parentStringId = `usc/${parentLevel.levelType}/${parentLevel.identifier}`;
				parentId = nodeIdMap.get(parentStringId) || null;
			}
			// Check if parent is a title
			if (!parentId && level.parentIdentifier.endsWith("-title")) {
				const titleStringId = `usc/title/${level.titleNum}`;
				parentId = nodeIdMap.get(titleStringId) || null;
			}
		}
		// Fall back to title if no parent found
		if (!parentId) {
			const titleStringId = `usc/title/${level.titleNum}`;
			parentId = nodeIdMap.get(titleStringId) || null;
		}

		// Generate readable heading citation (e.g., "Chapter 21", "Subchapter I")
		const headingCitation = `${level.levelType.charAt(0).toUpperCase() + level.levelType.slice(1)} ${level.num}`;

		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			level.levelType,
			level.levelIndex,
			i,
			level.heading,
			`/statutes/usc/${level.levelType}/${level.titleNum}/${level.num}`,
			level.num, // readable_id
			headingCitation,
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

		// Determine parent from parentLevelId (format: lvl_usc_{levelType}_{identifier})
		let parentId: number | null = null;
		const parentMatch = section.parentLevelId.match(/^lvl_usc_([^_]+)_(.+)$/);
		if (parentMatch) {
			const [, levelType, identifier] = parentMatch;
			if (levelType === "title") {
				const titleStringId = `usc/title/${identifier}`;
				parentId = nodeIdMap.get(titleStringId) || null;
			} else {
				const levelStringId = `usc/${levelType}/${identifier}`;
				parentId = nodeIdMap.get(levelStringId) || null;
			}
		}
		// Fall back to title if no parent found
		if (!parentId) {
			const titleStringId = `usc/title/${section.titleNum}`;
			parentId = nodeIdMap.get(titleStringId) || null;
		}

		// Create content JSON
		const crossReferences = extractSectionCrossReferences(
			[section.body, section.citations].filter(Boolean).join("\n"),
			section.titleNum,
		);
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
			...(crossReferences.length > 0
				? { metadata: { cross_references: crossReferences } }
				: {}),
		};

		// Store in packfile
		const blobHash = await blobStore.storeJson(content);

		// Insert node
		const stringId = `usc/section/${section.titleNum}-${section.sectionNum}`;
		const readableId = `${section.titleNum} USC ${section.sectionNum}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			"section",
			SECTION_LEVEL_INDEX,
			i,
			section.heading,
			section.path,
			readableId,
			readableId, // heading_citation same as readableId for USC sections
			blobHash,
			null,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;

		if (nodesCreated % 100 === 0) {
			console.log(`Created ${nodesCreated} nodes...`);
		}
	}

	// Flush any remaining blobs to packfiles
	await blobStore.flush();

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

function compareLevelKeys(
	a: [
		[number, [number, string] | string],
		number,
		[number, [number, string] | string],
	],
	b: [
		[number, [number, string] | string],
		number,
		[number, [number, string] | string],
	],
): number {
	// Compare by title first
	const titleCmp = compareKeys(a[0], b[0]);
	if (titleCmp !== 0) return titleCmp;
	// Then by level index
	if (a[1] !== b[1]) return a[1] - b[1];
	// Then by level number
	return compareKeys(a[2], b[2]);
}
