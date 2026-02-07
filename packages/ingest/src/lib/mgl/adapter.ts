import type { NodeMeta } from "../../types";
import type {
	GenericWorkflowAdapter,
	RootPlan,
	ShardWorkItem,
	UnitPlan,
} from "../workflows/generic";
import { extractSectionCrossReferences } from "./cross-references";
import {
	fetchMglHtmlWithCache,
	fetchMglRootHtml,
	fetchMglTitleChapters,
} from "./fetcher";
import {
	designatorSortOrder,
	extractVersionIdFromRoot,
	type MglPart,
	parseChaptersFromTitleResponse,
	parsePartsFromRoot,
	parseSectionContent,
	parseSectionsFromChapterPage,
	parseTitlesFromPart,
} from "./parser";

const SOURCE_CODE = "mgl";
const SOURCE_NAME = "Massachusetts General Laws";
const SECTION_LEVEL_INDEX = 3;
const BLOB_STORE_BATCH_SIZE = 50;

interface MglUnitRoot extends MglPart {
	id: string;
}

type MglShardMeta =
	| { kind: "node"; node: NodeMeta }
	| {
			kind: "section";
			partCode: string;
			titleCode: string;
			chapterNumber: string;
			sectionNumber: string;
			sectionName: string;
			sectionUrl: string;
			sortOrder: number;
	  };

type MglSectionShardItem = ShardWorkItem<
	Extract<MglShardMeta, { kind: "section" }>
>;

function createRootNodePlan(versionId: string, startUrl: string): NodeMeta {
	return {
		id: `${SOURCE_CODE}/${versionId}/root`,
		source_version_id: "",
		parent_id: null,
		level_name: "root",
		level_index: -1,
		sort_order: 0,
		name: SOURCE_NAME,
		path: "/statutes/mgl",
		readable_id: "MGL",
		heading_citation: "MGL",
		source_url: startUrl,
		accessed_at: new Date().toISOString(),
	};
}

function makePartId(rootId: string, partCode: string): string {
	return `${rootId}/part-${partCode.toLowerCase()}`;
}

function makeTitleId(partId: string, titleCode: string): string {
	return `${partId}/title-${titleCode.toLowerCase()}`;
}

function makeChapterId(titleId: string, chapterNumber: string): string {
	return `${titleId}/chapter-${chapterNumber.toLowerCase()}`;
}

function makeSectionId(chapterId: string, sectionNumber: string): string {
	return `${chapterId}/section-${sectionNumber.toLowerCase()}`;
}

function normalizeName(name: string): string {
	return name.replace(/\s+/g, " ").trim();
}

export const mglAdapter: GenericWorkflowAdapter<MglUnitRoot, MglShardMeta> = {
	source: {
		code: SOURCE_CODE,
		name: SOURCE_NAME,
		jurisdiction: "state",
		region: "MA",
		docType: "statute",
	},
	maxUnitConcurrency: 1,

	async discoverRoot({ env }): Promise<RootPlan<MglUnitRoot>> {
		const startUrl = `${env.MGL_BASE_URL}${env.MGL_START_PATH}`;
		const rootHtml = await fetchMglRootHtml(startUrl);
		const versionId = extractVersionIdFromRoot(rootHtml);

		await env.STORAGE.put(`sources/mgl/${versionId}/root.html`, rootHtml, {
			httpMetadata: { contentType: "text/html" },
		});

		const parts = parsePartsFromRoot(rootHtml, startUrl);
		const unitRoots: MglUnitRoot[] = parts.map((part) => ({
			...part,
			id: `part-${part.partCode.toLowerCase()}`,
		}));

		return {
			versionId,
			rootNode: createRootNodePlan(versionId, startUrl),
			unitRoots,
		};
	},

	async planUnit({ env, root, unit }): Promise<UnitPlan<MglShardMeta>> {
		const accessedAt = new Date().toISOString();
		const partId = makePartId(root.rootNode.id, unit.partCode);
		const shardItems: Array<ShardWorkItem<MglShardMeta>> = [];
		const seenSectionIds = new Set<string>();

		const partNode: NodeMeta = {
			id: partId,
			source_version_id: root.sourceVersionId,
			parent_id: root.rootNode.id,
			level_name: "part",
			level_index: 0,
			sort_order: unit.sortOrder,
			name: normalizeName(unit.partName),
			path: `/statutes/mgl/part/${unit.partCode.toLowerCase()}`,
			readable_id: `Part ${unit.partCode}`,
			heading_citation: `Part ${unit.partCode}`,
			source_url: unit.partUrl,
			accessed_at: accessedAt,
		};

		shardItems.push({
			parentId: root.rootNode.id,
			childId: partId,
			sourceUrl: unit.partUrl,
			meta: { kind: "node", node: partNode },
		});

		const partHtml = await fetchMglHtmlWithCache(
			env,
			root.versionId,
			unit.partUrl,
		);
		const titles = parseTitlesFromPart(partHtml);

		for (const title of titles) {
			const titleId = makeTitleId(partId, title.titleCode);
			const titleNode: NodeMeta = {
				id: titleId,
				source_version_id: root.sourceVersionId,
				parent_id: partId,
				level_name: "title",
				level_index: 1,
				sort_order: title.sortOrder,
				name: normalizeName(title.titleName),
				path: `/statutes/mgl/part/${unit.partCode.toLowerCase()}/title/${title.titleCode.toLowerCase()}`,
				readable_id: `Title ${title.titleCode}`,
				heading_citation: `Title ${title.titleCode}`,
				source_url: `${unit.partUrl}/Title${title.titleCode}`,
				accessed_at: accessedAt,
			};

			shardItems.push({
				parentId: partId,
				childId: titleId,
				sourceUrl: titleNode.source_url ?? unit.partUrl,
				meta: { kind: "node", node: titleNode },
			});

			const chaptersHtml = await fetchMglTitleChapters(
				env,
				root.versionId,
				env.MGL_BASE_URL,
				unit.partId,
				title.titleId,
				title.titleCode,
			);
			const chapters = parseChaptersFromTitleResponse(
				chaptersHtml,
				env.MGL_BASE_URL,
			);

			for (const chapter of chapters) {
				const chapterId = makeChapterId(titleId, chapter.chapterNumber);
				const chapterNode: NodeMeta = {
					id: chapterId,
					source_version_id: root.sourceVersionId,
					parent_id: titleId,
					level_name: "chapter",
					level_index: 2,
					sort_order: designatorSortOrder(chapter.chapterNumber),
					name: normalizeName(chapter.chapterName),
					path: `/statutes/mgl/part/${unit.partCode.toLowerCase()}/title/${title.titleCode.toLowerCase()}/chapter/${chapter.chapterNumber.toLowerCase()}`,
					readable_id: `Chapter ${chapter.chapterNumber}`,
					heading_citation: `Chapter ${chapter.chapterNumber}`,
					source_url: chapter.chapterUrl,
					accessed_at: accessedAt,
				};

				shardItems.push({
					parentId: titleId,
					childId: chapterId,
					sourceUrl: chapter.chapterUrl,
					meta: { kind: "node", node: chapterNode },
				});

				const chapterHtml = await fetchMglHtmlWithCache(
					env,
					root.versionId,
					chapter.chapterUrl,
				);
				const sections = parseSectionsFromChapterPage(
					chapterHtml,
					env.MGL_BASE_URL,
				);

				for (const section of sections) {
					const sectionId = makeSectionId(chapterId, section.sectionNumber);
					if (seenSectionIds.has(sectionId)) continue;
					seenSectionIds.add(sectionId);

					shardItems.push({
						parentId: chapterId,
						childId: sectionId,
						sourceUrl: section.sectionUrl,
						meta: {
							kind: "section",
							partCode: unit.partCode,
							titleCode: title.titleCode,
							chapterNumber: chapter.chapterNumber,
							sectionNumber: section.sectionNumber,
							sectionName: normalizeName(section.sectionName),
							sectionUrl: section.sectionUrl,
							sortOrder: section.sortOrder,
						},
					});
				}
			}
		}

		return {
			unitId: unit.id,
			shardItems,
		};
	},

	async loadShardItems({
		env,
		root,
		sourceVersionId,
		items,
		nodeStore,
		blobStore,
	}): Promise<void> {
		const accessedAt = new Date().toISOString();
		const sectionItems: MglSectionShardItem[] = [];
		const pendingWrites: Array<{ node: NodeMeta; content: unknown }> = [];

		for (const item of items) {
			if (item.meta.kind === "node") {
				await nodeStore.store(item.meta.node, null);
				continue;
			}
			sectionItems.push(item as MglSectionShardItem);
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

		for (const item of sectionItems) {
			const sectionHtml = await fetchMglHtmlWithCache(
				env,
				root.versionId,
				item.meta.sectionUrl,
			);
			const parsed = parseSectionContent(sectionHtml);
			const sectionHeading = parsed.heading || item.meta.sectionName;
			const crossReferences = extractSectionCrossReferences(parsed.body);
			const readableId = `MGL c.${item.meta.chapterNumber} §${item.meta.sectionNumber}`;
			const path = `/statutes/mgl/part/${item.meta.partCode.toLowerCase()}/title/${item.meta.titleCode.toLowerCase()}/chapter/${item.meta.chapterNumber.toLowerCase()}/section/${item.meta.sectionNumber.toLowerCase()}`;

			pendingWrites.push({
				node: {
					id: item.childId,
					source_version_id: sourceVersionId,
					parent_id: item.parentId,
					level_name: "section",
					level_index: SECTION_LEVEL_INDEX,
					sort_order: item.meta.sortOrder,
					name: sectionHeading,
					path,
					readable_id: readableId,
					heading_citation: readableId,
					source_url: item.meta.sectionUrl,
					accessed_at: accessedAt,
				},
				content: {
					blocks: [{ type: "body", content: parsed.body }],
					...(crossReferences.length > 0
						? { metadata: { cross_references: crossReferences } }
						: {}),
				},
			});

			if (pendingWrites.length >= BLOB_STORE_BATCH_SIZE) {
				await flushPendingWrites();
			}
		}

		await flushPendingWrites();
	},
};

export type { MglShardMeta, MglUnitRoot };
