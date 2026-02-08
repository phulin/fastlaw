import type { NodeMeta } from "../../types";
import type {
	GenericWorkflowAdapter,
	RootPlan,
	ShardWorkItem,
	UnitPlan,
} from "../ingest/adapter-types";
import { extractSectionCrossReferences } from "./cross-references";
import {
	fetchUSCTitleStreaming,
	getReleasePointFromTitleUrls,
	getTitleNumFromUrl,
	getUSCTitleUrls,
} from "./fetcher";
import {
	streamUSCSectionContentXmlFromChunks,
	streamUSCStructureXmlFromChunks,
	titleSortKey,
	USC_LEVEL_INDEX,
	type USCLevel,
	type USCLevelType,
	type USCParentRef,
} from "./parser";

const SOURCE_CODE = "usc";
const SOURCE_NAME = "United States Code";

const SECTION_LEVEL_INDEX = Object.keys(USC_LEVEL_INDEX).length;
const BLOB_STORE_BATCH_SIZE = 50;

interface UscUnitRoot {
	id: string;
	titleNum: string;
	url: string;
}

type UscShardMeta =
	| { kind: "node"; node: NodeMeta }
	| { kind: "section"; sectionKey: string };
type UscSectionShardItem = ShardWorkItem<
	Extract<UscShardMeta, { kind: "section" }>
>;

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

function resolveLevelParentStringId(
	rootStringId: string,
	level: USCLevel,
	levelTypeByIdentifier: Map<string, USCLevelType>,
): string {
	if (level.parentIdentifier?.endsWith("-title")) {
		return `${rootStringId}/title-${level.titleNum}`;
	}
	if (level.parentIdentifier) {
		const parentType = levelTypeByIdentifier.get(level.parentIdentifier);
		if (parentType) {
			return `${rootStringId}/${parentType}-${level.parentIdentifier}`;
		}
	}
	return `${rootStringId}/title-${level.titleNum}`;
}

function resolveSectionParentStringId(
	rootStringId: string,
	parentRef: USCParentRef,
): string {
	if (parentRef.kind === "title") {
		return `${rootStringId}/title-${parentRef.titleNum}`;
	}
	return `${rootStringId}/${parentRef.levelType}-${parentRef.identifier}`;
}

export const uscAdapter: GenericWorkflowAdapter<UscUnitRoot, UscShardMeta> = {
	source: {
		code: SOURCE_CODE,
		name: SOURCE_NAME,
		jurisdiction: "federal",
		region: "US",
		docType: "statute",
	},
	maxUnitConcurrency: 1,

	async discoverRoot({ env }): Promise<RootPlan<UscUnitRoot>> {
		const titleUrls = await getUSCTitleUrls();
		const releasePoint = getReleasePointFromTitleUrls(titleUrls);

		const titlesToProcess = titleUrls
			.map((url) => ({
				titleNum: getTitleNumFromUrl(url) ?? "",
				url,
			}))
			.filter((entry) => entry.titleNum);

		const sortedTitles = titlesToProcess.sort((a, b) =>
			compareKeys(titleSortKey(a.titleNum), titleSortKey(b.titleNum)),
		);

		const unitRoots: UscUnitRoot[] = sortedTitles.map((t) => ({
			id: `title-${t.titleNum}`,
			titleNum: t.titleNum,
			url: t.url,
		}));

		const rootNode: NodeMeta = {
			id: `${SOURCE_CODE}/${releasePoint}/root`,
			source_version_id: "",
			parent_id: null,
			level_name: "root",
			level_index: -1,
			sort_order: 0,
			name: SOURCE_NAME,
			path: "/statutes/usc",
			readable_id: "USC",
			heading_citation: "USC",
			source_url: env.USC_DOWNLOAD_BASE,
			accessed_at: new Date().toISOString(),
		};

		return { versionId: releasePoint, rootNode, unitRoots };
	},

	async planUnit({ env, root, unit }): Promise<UnitPlan<UscShardMeta>> {
		const accessedAt = new Date().toISOString();
		const rootStringId = root.rootNode.id;
		const titleOrder = new Map<string, number>();
		for (let i = 0; i < root.unitRoots.length; i++) {
			titleOrder.set(root.unitRoots[i].titleNum, i);
		}

		const chunks = await fetchUSCTitleStreaming(unit.url, env.STORAGE);
		if (!chunks) {
			console.warn(`Skipping Title ${unit.titleNum}: no XML content`);
			return { unitId: unit.id, shardItems: [] };
		}

		const stream = streamUSCStructureXmlFromChunks(
			chunks,
			unit.titleNum,
			unit.url,
		);
		const shardItems: Array<ShardWorkItem<UscShardMeta>> = [];

		const seenLevelIds = new Set<string>();
		const levelTypeByIdentifier = new Map<string, USCLevelType>();
		const seenSections = new Set<string>();
		let levelSortOrder = 0;

		const ensureTitleShard = (titleNum: string, titleName: string) => {
			const titleStringId = `${rootStringId}/title-${titleNum}`;
			if (seenLevelIds.has(`title-${titleNum}`)) return;
			seenLevelIds.add(`title-${titleNum}`);

			const sortOrder = titleOrder.get(titleNum) ?? titleOrder.size;
			const titleNode: NodeMeta = {
				id: titleStringId,
				source_version_id: root.sourceVersionId,
				parent_id: rootStringId,
				level_name: "title",
				level_index: 0,
				sort_order: sortOrder,
				name: titleName,
				path: `/statutes/usc/title/${titleNum}`,
				readable_id: titleNum,
				heading_citation: `Title ${titleNum}`,
				source_url: unit.url,
				accessed_at: accessedAt,
			};

			shardItems.push({
				parentId: rootStringId,
				childId: titleStringId,
				sourceUrl: unit.url,
				meta: { kind: "node", node: titleNode },
			});
		};

		for await (const value of stream) {
			if (value.type === "title") {
				ensureTitleShard(value.titleNum, value.titleName);
				continue;
			}

			if (value.type === "level") {
				const level = value.level;
				if (seenLevelIds.has(level.identifier)) continue;
				ensureTitleShard(level.titleNum, `Title ${level.titleNum}`);

				const parentStringId = resolveLevelParentStringId(
					rootStringId,
					level,
					levelTypeByIdentifier,
				);
				const stringId = `${rootStringId}/${level.levelType}-${level.identifier}`;
				const headingCitation = `${level.levelType.charAt(0).toUpperCase() + level.levelType.slice(1)} ${level.num}`;

				const levelNode: NodeMeta = {
					id: stringId,
					source_version_id: root.sourceVersionId,
					parent_id: parentStringId,
					level_name: level.levelType,
					level_index: level.levelIndex,
					sort_order: levelSortOrder++,
					name: level.heading,
					path: `/statutes/usc/${level.levelType}/${level.titleNum}/${level.num}`,
					readable_id: level.num,
					heading_citation: headingCitation,
					source_url: null,
					accessed_at: accessedAt,
				};

				shardItems.push({
					parentId: parentStringId,
					childId: stringId,
					sourceUrl: unit.url,
					meta: { kind: "node", node: levelNode },
				});

				levelTypeByIdentifier.set(level.identifier, level.levelType);
				seenLevelIds.add(level.identifier);
				continue;
			}

			const section = value.section;
			const parentStringId = resolveSectionParentStringId(
				rootStringId,
				section.parentRef,
			);
			const stringId = `${parentStringId}/section-${section.sectionNum}`;
			if (seenSections.has(stringId)) {
				console.error(`Duplicate section found: ${stringId}`);
				continue;
			}
			seenSections.add(stringId);

			shardItems.push({
				parentId: parentStringId,
				childId: stringId,
				sourceUrl: unit.url,
				meta: {
					kind: "section",
					sectionKey: section.sectionKey,
				},
			});
		}

		ensureTitleShard(unit.titleNum, `Title ${unit.titleNum}`);

		console.log(
			`Planned Title ${unit.titleNum}: ${shardItems.length} shard items`,
		);

		return { unitId: unit.id, shardItems };
	},

	async loadShardItems({
		env,
		unit,
		sourceVersionId,
		items,
		nodeStore,
		blobStore,
	}): Promise<void> {
		const accessedAt = new Date().toISOString();
		const sectionItems: UscSectionShardItem[] = [];
		const pendingWrites: Array<{
			node: NodeMeta;
			content: unknown;
		}> = [];

		for (const item of items) {
			if (item.meta.kind === "node") {
				await nodeStore.store(item.meta.node, null);
				continue;
			}
			sectionItems.push(item as UscSectionShardItem);
		}

		if (sectionItems.length === 0) return;

		const flushPendingWrites = async () => {
			if (pendingWrites.length === 0) return;
			const blobHashes = await blobStore.storeJsonBatch(
				pendingWrites.map((entry) => entry.content),
			);
			for (let i = 0; i < pendingWrites.length; i++) {
				await nodeStore.store(pendingWrites[i].node, blobHashes[i]);
			}
			pendingWrites.length = 0;
		};

		// Re-parse the title XML to extract section content
		const chunks = await fetchUSCTitleStreaming(unit.url, env.STORAGE);
		if (!chunks) {
			throw new Error(
				`Failed to re-fetch Title ${unit.titleNum} for shard loading`,
			);
		}

		const stream = streamUSCSectionContentXmlFromChunks(
			chunks,
			unit.titleNum,
			unit.url,
		);
		const sectionItemByKey = new Map(
			sectionItems.map((item) => [item.meta.sectionKey, item] as const),
		);

		for await (const section of stream) {
			const item = sectionItemByKey.get(section.sectionKey);
			if (!item) continue;

			const crossReferences = extractSectionCrossReferences(
				[section.body, section.citations].filter(Boolean).join("\n"),
				section.titleNum,
			);

			const content: {
				blocks: Array<{ type: string; content: string; label?: string }>;
				metadata?: {
					cross_references: typeof crossReferences;
				};
			} = {
				blocks: [
					{ type: "body", content: section.body },
					...(section.historyShort
						? [
								{
									type: "history_short" as const,
									label: "Short History",
									content: section.historyShort,
								},
							]
						: []),
					...(section.historyLong
						? [
								{
									type: "history_long" as const,
									label: "Long History",
									content: section.historyLong,
								},
							]
						: []),
					...(section.citations
						? [
								{
									type: "citations" as const,
									label: "Notes",
									content: section.citations,
								},
							]
						: []),
				],
			};

			if (crossReferences.length > 0) {
				content.metadata = { cross_references: crossReferences };
			}

			const readableId = `${section.titleNum} USC ${section.sectionNum}`;
			pendingWrites.push({
				node: {
					id: item.childId,
					source_version_id: sourceVersionId,
					parent_id: item.parentId,
					level_name: "section",
					level_index: SECTION_LEVEL_INDEX,
					sort_order: 0,
					name: section.heading,
					path: section.path,
					readable_id: readableId,
					heading_citation: readableId,
					source_url: null,
					accessed_at: accessedAt,
				},
				content,
			});
			if (pendingWrites.length >= BLOB_STORE_BATCH_SIZE) {
				await flushPendingWrites();
			}

			sectionItemByKey.delete(section.sectionKey);
		}
		await flushPendingWrites();

		if (sectionItemByKey.size > 0) {
			const missingKey = sectionItemByKey.keys().next().value;
			throw new Error(
				`Missing section ${missingKey} in Title ${unit.titleNum}`,
			);
		}
	},
};

export type { UscUnitRoot, UscShardMeta };
