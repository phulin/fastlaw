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
import { extractSectionCrossReferences } from "./cross-references";
import { fetchUSCTitle, getTitleNumFromUrl, getUSCTitleUrls } from "./fetcher";
import {
	streamUSCXml,
	titleSortKey,
	USC_LEVEL_INDEX,
	type USCLevel,
	type USCLevelType,
	type USCSection,
} from "./parser";

const SOURCE_CODE = "usc";
const SOURCE_NAME = "United States Code";

/** Section level index is one higher than the highest organizational level */
const SECTION_LEVEL_INDEX = Object.keys(USC_LEVEL_INDEX).length;
const SECTION_BATCH_SIZE = 500;

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

	console.log("Fetching USC title list from House OLRC...");
	const titlesToProcess = titleUrls
		.map((url) => ({
			titleNum: getTitleNumFromUrl(url) ?? "",
			url,
			sourceUrl: url,
		}))
		.filter((entry) => entry.titleNum);

	const sortedTitles = titlesToProcess.sort((a, b) => {
		const aKey = titleSortKey(a.titleNum);
		const bKey = titleSortKey(b.titleNum);
		return compareKeys(aKey, bKey);
	});

	const titleOrder = new Map<string, number>();
	for (let i = 0; i < sortedTitles.length; i += 1) {
		titleOrder.set(sortedTitles[i].titleNum, i);
	}

	console.log(`Processing ${sortedTitles.length} USC titles`);

	// Insert nodes into database
	let nodesCreated = 0;
	const nodeIdMap = new Map<string, number>();

	// Initialize blob store for this source
	const blobStore = new BlobStore(env.DB, env.STORAGE, sourceId, SOURCE_CODE);

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

	const seenLevelIds = new Set<string>();
	const levelTypeByIdentifier = new Map<string, USCLevelType>();
	const seenSections = new Set<string>();
	const sectionNodes: NodeInsert[] = [];
	let levelSortOrder = 0;
	let sectionSortOrder = 0;
	let crossRefTime = 0;
	let blobStoreTime = 0;
	let totalSections = 0;

	const ensureTitleNode = async (titleNum: string, titleName: string) => {
		const titleStringId = `usc/title/${titleNum}`;
		if (nodeIdMap.has(titleStringId)) {
			return nodeIdMap.get(titleStringId) ?? null;
		}

		const sortOrder = titleOrder.get(titleNum) ?? titleOrder.size;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			titleStringId,
			rootNodeId,
			"title",
			0,
			sortOrder,
			titleName,
			`/statutes/usc/title/${titleNum}`,
			titleNum,
			`Title ${titleNum}`,
			null,
			titleUrlByNum.get(titleNum) ?? "",
			accessedAt,
		);
		nodeIdMap.set(titleStringId, nodeId);
		nodesCreated += 1;
		return nodeId;
	};

	const resolveLevelParentId = (level: USCLevel): number | null => {
		if (level.parentIdentifier?.endsWith("-title")) {
			return nodeIdMap.get(`usc/title/${level.titleNum}`) ?? null;
		}
		if (level.parentIdentifier) {
			const parentType = levelTypeByIdentifier.get(level.parentIdentifier);
			if (parentType) {
				return (
					nodeIdMap.get(`usc/${parentType}/${level.parentIdentifier}`) ?? null
				);
			}
		}
		return nodeIdMap.get(`usc/title/${level.titleNum}`) ?? null;
	};

	const resolveSectionParentId = (section: USCSection): number | null => {
		const parentMatch = section.parentLevelId.match(/^lvl_usc_([^_]+)_(.+)$/);
		if (parentMatch) {
			const [, levelType, identifier] = parentMatch;
			if (levelType === "title") {
				return nodeIdMap.get(`usc/title/${identifier}`) ?? null;
			}
			return nodeIdMap.get(`usc/${levelType}/${identifier}`) ?? null;
		}
		return nodeIdMap.get(`usc/title/${section.titleNum}`) ?? null;
	};

	const flushSectionNodes = async () => {
		if (sectionNodes.length === 0) return;
		const batch = sectionNodes.splice(0, sectionNodes.length);
		const sectionIdMap = await insertNodesBatched(env.DB, batch);
		for (const [stringId, nodeId] of sectionIdMap) {
			nodeIdMap.set(stringId, nodeId);
		}
		nodesCreated += batch.length;
	};

	for (const titleEntry of sortedTitles) {
		const titleNum = titleEntry.titleNum;
		const sourceUrl = titleUrlByNum.get(titleNum) ?? titleEntry.sourceUrl;
		const titleStart = Date.now();
		let titleLevels = 0;
		let titleSections = 0;

		try {
			let input: ReadableStream<Uint8Array> | string | null = null;

			const xml = await fetchUSCTitle(titleEntry.url, env.STORAGE);
			if (xml) input = xml;

			if (!input) {
				console.warn(`Skipping Title ${titleNum}: no XML content`);
				continue;
			}

			const stream = streamUSCXml(input, titleNum, sourceUrl);
			while (true) {
				const { value, done } = await stream.next();
				if (done) {
					await ensureTitleNode(value.titleNum, value.titleName);
					break;
				}

				if (value.type === "title") {
					await ensureTitleNode(value.titleNum, value.titleName);
				}

				if (value.type === "level") {
					const level = value.level;
					if (seenLevelIds.has(level.identifier)) continue;
					await ensureTitleNode(level.titleNum, `Title ${level.titleNum}`);

					const stringId = `usc/${level.levelType}/${level.identifier}`;
					const headingCitation = `${level.levelType.charAt(0).toUpperCase() + level.levelType.slice(1)} ${level.num}`;
					const nodeId = await insertNode(
						env.DB,
						versionId,
						stringId,
						resolveLevelParentId(level),
						level.levelType,
						level.levelIndex,
						levelSortOrder++,
						level.heading,
						`/statutes/usc/${level.levelType}/${level.titleNum}/${level.num}`,
						level.num,
						headingCitation,
						null,
						null,
						accessedAt,
					);

					nodeIdMap.set(stringId, nodeId);
					levelTypeByIdentifier.set(level.identifier, level.levelType);
					seenLevelIds.add(level.identifier);
					nodesCreated += 1;
					titleLevels += 1;
				}

				if (value.type === "section") {
					const section = value.section;
					const stringId = `usc/section/${section.titleNum}-${section.sectionNum}`;
					if (seenSections.has(stringId)) {
						console.error(`Duplicate section found: ${stringId}`);
						continue;
					}
					seenSections.add(stringId);

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
								? [
										{
											type: "citations",
											label: "Notes",
											content: section.citations,
										},
									]
								: []),
						],
						...(crossReferences.length > 0
							? { metadata: { cross_references: crossReferences } }
							: {}),
					};

					const blobStart = Date.now();
					const blobHash = await blobStore.storeJson(content);
					blobStoreTime += Date.now() - blobStart;

					const readableId = `${section.titleNum} USC ${section.sectionNum}`;
					sectionNodes.push({
						source_version_id: versionId,
						string_id: stringId,
						parent_id: resolveSectionParentId(section),
						level_name: "section",
						level_index: SECTION_LEVEL_INDEX,
						sort_order: sectionSortOrder++,
						name: section.heading,
						path: section.path,
						readable_id: readableId,
						heading_citation: readableId,
						blob_hash: blobHash,
						source_url: null,
						accessed_at: accessedAt,
					});

					titleSections += 1;
					totalSections += 1;

					if (sectionNodes.length >= SECTION_BATCH_SIZE) {
						await flushSectionNodes();
						console.log(
							`Inserted ${totalSections} sections so far (crossRef: ${crossRefTime}ms, blobStore: ${blobStoreTime}ms)`,
						);
					}
				}
			}

			console.log(
				`  Title ${titleNum}: ${titleLevels} levels, ${titleSections} sections in ${Date.now() - titleStart}ms`,
			);
		} catch (error) {
			console.error(`Error parsing Title ${titleNum}:`, error);
		}
	}

	await flushSectionNodes();

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
