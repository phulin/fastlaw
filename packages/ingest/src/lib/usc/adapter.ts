import type { NodeMeta } from "../../types";
import type {
	GenericWorkflowAdapter,
	RootPlan,
	ShardItem,
	ShardWorkItem,
	UnitPlan,
} from "../workflows/generic";
import { extractSectionCrossReferences } from "./cross-references";
import {
	fetchUSCTitleStreaming,
	getReleasePointFromTitleUrls,
	getTitleNumFromUrl,
	getUSCTitleUrls,
} from "./fetcher";
import {
	streamUSCXmlFromChunks,
	titleSortKey,
	USC_LEVEL_INDEX,
	type USCLevel,
	type USCLevelType,
	type USCSection,
} from "./parser";

const SOURCE_CODE = "usc";
const SOURCE_NAME = "United States Code";

const SECTION_LEVEL_INDEX = Object.keys(USC_LEVEL_INDEX).length;

interface UscUnitRoot {
	id: string;
	titleNum: string;
	url: string;
}

type UscShardMeta =
	| { kind: "node"; node: NodeMeta }
	| { kind: "section"; sectionNum: string; titleNum: string };

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
	section: USCSection,
): string {
	const parentMatch = section.parentLevelId.match(/^lvl_usc_([^_]+)_(.+)$/);
	if (parentMatch) {
		const [, levelType, identifier] = parentMatch;
		if (levelType === "title") {
			return `${rootStringId}/title-${identifier}`;
		}
		return `${rootStringId}/${levelType}-${identifier}`;
	}
	return `${rootStringId}/title-${section.titleNum}`;
}

export const uscAdapter: GenericWorkflowAdapter<UscUnitRoot, UscShardMeta> = {
	source: {
		code: SOURCE_CODE,
		name: SOURCE_NAME,
		jurisdiction: "federal",
		region: "US",
		docType: "statute",
	},
	maxUnitConcurrency: 5,

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

		const stream = streamUSCXmlFromChunks(chunks, unit.titleNum, unit.url, {
			includeSectionContent: false,
		});
		const shardItems: Array<ShardWorkItem<UscShardMeta>> = [];

		const seenLevelIds = new Set<string>();
		const levelTypeByIdentifier = new Map<string, USCLevelType>();
		const sectionCounts = new Map<string, number>();
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

		while (true) {
			const { value, done } = await stream.next();
			if (done) {
				ensureTitleShard(value.titleNum, value.titleName);
				break;
			}

			if (value.type === "title") {
				ensureTitleShard(value.titleNum, value.titleName);
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
			}

			if (value.type === "section") {
				const section = value.section;
				const parentStringId = resolveSectionParentStringId(
					rootStringId,
					section,
				);

				const baseSectionNum = section.sectionNum;
				const sectionKey = `${section.titleNum}-${baseSectionNum}`;
				const count = sectionCounts.get(sectionKey) ?? 0;
				sectionCounts.set(sectionKey, count + 1);
				const finalSectionNum =
					count === 0 ? baseSectionNum : `${baseSectionNum}-${count + 1}`;

				const stringId = `${parentStringId}/section-${finalSectionNum}`;
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
						sectionNum: finalSectionNum,
						titleNum: section.titleNum,
					},
				});
			}
		}

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
	}): Promise<ShardItem[]> {
		const accessedAt = new Date().toISOString();
		const results: ShardItem[] = [];
		const sectionItems: Array<ShardWorkItem<UscShardMeta>> = [];

		for (const item of items) {
			if (item.meta.kind === "node") {
				results.push({ node: item.meta.node, content: null });
				continue;
			}
			sectionItems.push(item);
		}

		if (sectionItems.length === 0) return results;

		// Re-parse the title XML to extract section content
		const chunks = await fetchUSCTitleStreaming(unit.url, env.STORAGE);
		if (!chunks) {
			throw new Error(
				`Failed to re-fetch Title ${unit.titleNum} for shard loading`,
			);
		}

		const stream = streamUSCXmlFromChunks(chunks, unit.titleNum, unit.url);
		const sectionsByNum = new Map<string, USCSection>();
		const sectionCounts = new Map<string, number>();

		while (true) {
			const { value, done } = await stream.next();
			if (done) break;

			if (value.type === "section") {
				const baseSectionNum = value.section.sectionNum;
				const sectionKey = `${value.section.titleNum}-${baseSectionNum}`;
				const count = sectionCounts.get(sectionKey) ?? 0;
				sectionCounts.set(sectionKey, count + 1);
				const finalSectionNum =
					count === 0 ? baseSectionNum : `${baseSectionNum}-${count + 1}`;
				sectionsByNum.set(finalSectionNum, value.section);
			}
		}

		for (const item of sectionItems) {
			if (item.meta.kind !== "section") continue;

			const section = sectionsByNum.get(item.meta.sectionNum);
			if (!section) {
				throw new Error(
					`Missing section ${item.meta.sectionNum} in Title ${item.meta.titleNum}`,
				);
			}

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

			const readableId = `${section.titleNum} USC ${item.meta.sectionNum}`;

			results.push({
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
		}

		return results;
	},
};

export type { UscUnitRoot, UscShardMeta };
