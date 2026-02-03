import type { IngestContext, IngestionResult } from "../../types";
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
export async function ingestUSC(env: IngestContext): Promise<IngestionResult> {
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
		env.db,
		SOURCE_CODE,
		SOURCE_NAME,
		"federal",
		"US",
		"statute",
	);

	// Get latest version for diff comparison
	const previousVersion = await getLatestVersion(env.db, sourceId);

	// Create new version
	const versionDate = new Date().toISOString().split("T")[0];
	const versionId = await getOrCreateSourceVersion(
		env.db,
		sourceId,
		versionDate,
	);

	// Try to fetch from R2 first (if pre-loaded), otherwise fetch from web
	console.log("Attempting to fetch USC XML from R2...");
	let xmlByTitle = await fetchUSCFromR2(env.storage, "usc_raw/");

	if (xmlByTitle.size === 0) {
		console.log("No R2 data found, fetching from House OLRC...");
		// Caches to R2 at sources/usc/ for future runs
		xmlByTitle = await fetchAllUSCTitles(100, 200, env.storage);
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
			console.log(
				`  Parsing Title ${titleNum} (${(xml.length / 1024 / 1024).toFixed(1)} MB)...`,
			);
			const parseStart = Date.now();
			const result = parseUSCXml(xml, titleNum, sourceUrl);
			console.log(`    Parsed in ${Date.now() - parseStart}ms`);

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
				`    Title ${titleNum}: ${result.levels.length} levels, ${result.sections.length} sections`,
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
	const blobStore = new BlobStore(env.db, env.storage, sourceId, SOURCE_CODE);

	// Insert root node
	const rootStringId = "usc/root";
	const rootNodeId = await insertNode(
		env.db,
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

	// Insert titles (sorted) - batched
	const sortedTitles = [...allTitles.entries()].sort((a, b) => {
		const aKey = titleSortKey(a[0]);
		const bKey = titleSortKey(b[0]);
		return compareKeys(aKey, bKey);
	});

	const titleNodes: NodeInsert[] = sortedTitles.map(
		([titleNum, titleName], i) => ({
			source_version_id: versionId,
			string_id: `usc/title/${titleNum}`,
			parent_id: rootNodeId,
			level_name: "title",
			level_index: 0,
			sort_order: i,
			name: titleName,
			path: `/statutes/usc/title/${titleNum}`,
			readable_id: titleNum,
			heading_citation: `Title ${titleNum}`,
			blob_hash: null,
			source_url: titleUrlByNum.get(titleNum) ?? "",
			accessed_at: accessedAt,
		}),
	);

	const titleIdMap = await insertNodesBatched(env.db, titleNodes);
	for (const [stringId, nodeId] of titleIdMap) {
		nodeIdMap.set(stringId, nodeId);
	}
	nodesCreated += titleNodes.length;

	// Insert organizational levels - batched by levelIndex to ensure parents before children
	const sortedLevels = [...allLevels].sort((a, b) => {
		const aKey = levelSortKey(a);
		const bKey = levelSortKey(b);
		return compareLevelKeys(aKey, bKey);
	});

	// Create identifier to level mapping for parent lookups
	const levelByIdentifier = new Map<string, USCLevel>();
	for (const level of sortedLevels) {
		levelByIdentifier.set(level.identifier, level);
	}

	// Group levels by levelIndex for batched insertion
	const levelsByIndex = new Map<number, USCLevel[]>();
	for (const level of sortedLevels) {
		const existing = levelsByIndex.get(level.levelIndex) ?? [];
		existing.push(level);
		levelsByIndex.set(level.levelIndex, existing);
	}

	// Helper to resolve parent ID for a level
	const resolveLevelParentId = (level: USCLevel): number | null => {
		if (level.parentIdentifier) {
			const parentLevel = levelByIdentifier.get(level.parentIdentifier);
			if (parentLevel) {
				const parentStringId = `usc/${parentLevel.levelType}/${parentLevel.identifier}`;
				const parentId = nodeIdMap.get(parentStringId);
				if (parentId) return parentId;
			}
			if (level.parentIdentifier.endsWith("-title")) {
				const titleStringId = `usc/title/${level.titleNum}`;
				return nodeIdMap.get(titleStringId) ?? null;
			}
		}
		// Fall back to title
		const titleStringId = `usc/title/${level.titleNum}`;
		return nodeIdMap.get(titleStringId) ?? null;
	};

	// Insert levels in waves by levelIndex (lower indices first = parents before children)
	const sortedLevelIndices = [...levelsByIndex.keys()].sort((a, b) => a - b);
	let levelSortOrder = 0;

	for (const levelIndex of sortedLevelIndices) {
		const levelsAtIndex = levelsByIndex.get(levelIndex) ?? [];

		const levelNodes: NodeInsert[] = levelsAtIndex.map((level) => {
			const stringId = `usc/${level.levelType}/${level.identifier}`;
			const headingCitation = `${level.levelType.charAt(0).toUpperCase() + level.levelType.slice(1)} ${level.num}`;
			const sortOrder = levelSortOrder++;

			return {
				source_version_id: versionId,
				string_id: stringId,
				parent_id: resolveLevelParentId(level),
				level_name: level.levelType,
				level_index: level.levelIndex,
				sort_order: sortOrder,
				name: level.heading,
				path: `/statutes/usc/${level.levelType}/${level.titleNum}/${level.num}`,
				readable_id: level.num,
				heading_citation: headingCitation,
				blob_hash: null,
				source_url: null,
				accessed_at: accessedAt,
			};
		});

		const levelIdMap = await insertNodesBatched(env.db, levelNodes);
		for (const [stringId, nodeId] of levelIdMap) {
			nodeIdMap.set(stringId, nodeId);
		}
		nodesCreated += levelNodes.length;
	}

	// Insert sections and store content in R2 - batched
	const sortedSections = allSections.sort((a, b) => {
		const aKey = [titleSortKey(a.titleNum), sectionSortKey(a.sectionNum)];
		const bKey = [titleSortKey(b.titleNum), sectionSortKey(b.sectionNum)];
		const titleCmp = compareKeys(aKey[0], bKey[0]);
		if (titleCmp !== 0) return titleCmp;
		return compareKeys(aKey[1], bKey[1]);
	});

	// Track seen section string_ids to detect duplicates
	const seenSections = new Map<string, USCSectionData>();

	// Helper to resolve parent ID for a section
	const resolveSectionParentId = (section: USCSectionData): number | null => {
		const parentMatch = section.parentLevelId.match(/^lvl_usc_([^_]+)_(.+)$/);
		if (parentMatch) {
			const [, levelType, identifier] = parentMatch;
			if (levelType === "title") {
				return nodeIdMap.get(`usc/title/${identifier}`) ?? null;
			}
			return nodeIdMap.get(`usc/${levelType}/${identifier}`) ?? null;
		}
		// Fall back to title
		return nodeIdMap.get(`usc/title/${section.titleNum}`) ?? null;
	};

	// First pass: store blobs and collect node data
	console.log(
		`Processing ${sortedSections.length} sections for blob storage...`,
	);
	const sectionNodes: NodeInsert[] = [];
	let crossRefTime = 0;
	let blobStoreTime = 0;

	for (let i = 0; i < sortedSections.length; i++) {
		const section = sortedSections[i];
		const stringId = `usc/section/${section.titleNum}-${section.sectionNum}`;

		// Check for duplicate
		const existing = seenSections.get(stringId);
		if (existing) {
			console.error(`Duplicate section found: ${stringId}`);
			console.error(`  First:  heading="${existing.heading}"`);
			console.error(`  Second: heading="${section.heading}"`);
			continue; // Skip duplicate
		}
		seenSections.set(stringId, section);

		// Create content JSON
		const crossRefStart = Date.now();
		const crossReferences = extractSectionCrossReferences(
			[section.body, section.citations].filter(Boolean).join("\n"),
			section.titleNum,
		);
		crossRefTime += Date.now() - crossRefStart;
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
					? [{ type: "citations", label: "Notes", content: section.citations }]
					: []),
			],
			...(crossReferences.length > 0
				? { metadata: { cross_references: crossReferences } }
				: {}),
		};

		// Store in packfile
		const blobStart = Date.now();
		const blobHash = await blobStore.storeJson(content);
		blobStoreTime += Date.now() - blobStart;

		// Collect node data for batch insert
		const readableId = `${section.titleNum} USC ${section.sectionNum}`;
		sectionNodes.push({
			source_version_id: versionId,
			string_id: stringId,
			parent_id: resolveSectionParentId(section),
			level_name: "section",
			level_index: SECTION_LEVEL_INDEX,
			sort_order: i,
			name: section.heading,
			path: section.path,
			readable_id: readableId,
			heading_citation: readableId,
			blob_hash: blobHash,
			source_url: null,
			accessed_at: accessedAt,
		});

		if ((i + 1) % 1000 === 0) {
			console.log(
				`Processed ${i + 1}/${sortedSections.length} sections (crossRef: ${crossRefTime}ms, blobStore: ${blobStoreTime}ms)`,
			);
		}
	}

	// Batch insert all section nodes
	console.log(`Batch inserting ${sectionNodes.length} section nodes...`);
	const sectionIdMap = await insertNodesBatched(env.db, sectionNodes);
	for (const [stringId, nodeId] of sectionIdMap) {
		nodeIdMap.set(stringId, nodeId);
	}
	nodesCreated += sectionNodes.length;

	// Flush any remaining blobs to packfiles
	await blobStore.flush();

	// Set root node ID
	await setRootNodeId(env.db, versionId, rootNodeId);

	// Compute diff if there was a previous version
	let diff = null;
	if (previousVersion) {
		diff = await computeDiff(env.db, previousVersion.id, versionId);
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
