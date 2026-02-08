import type { NodeMeta } from "../../types";
import type {
	GenericWorkflowAdapter,
	RootPlan,
	ShardWorkItem,
	UnitPlan,
} from "../ingest/adapter-types";
import { extractSectionCrossReferences } from "./cross-references";
import {
	fetchMglChapter,
	fetchMglLandingHtml,
	fetchMglPart,
	fetchMglParts,
	fetchMglSection,
} from "./fetcher";
import {
	designatorSortOrder,
	extractVersionIdFromLandingHtml,
	type MglPart,
	parseChapterDetail,
	parsePartDetail,
	parsePartSummary,
	parseSectionContent,
	parseSectionSummary,
} from "./parser";
import { normalizeMglApiUrl, normalizeMglPublicUrl } from "./utils";

const SOURCE_CODE = "mgl";
const SOURCE_NAME = "Massachusetts General Laws";
const SECTION_LEVEL_INDEX = 2;
const BLOB_STORE_BATCH_SIZE = 50;

interface MglUnitRoot extends MglPart {
	id: string;
}

type MglShardMeta =
	| { kind: "node"; node: NodeMeta }
	| {
			kind: "section";
			partCode: string;
			chapterCode: string;
			sectionCode: string;
			sectionApiUrl: string;
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

function makeChapterId(partId: string, chapterCode: string): string {
	return `${partId}/chapter-${chapterCode.toLowerCase()}`;
}

function makeSectionId(chapterId: string, sectionCode: string): string {
	return `${chapterId}/section-${sectionCode.toLowerCase()}`;
}

function normalizeName(name: string): string {
	return name.replace(/\s+/g, " ").trim();
}

function getApiUrl(rawUrl: string, baseUrl: string): string {
	return (
		normalizeMglApiUrl(rawUrl, baseUrl) ?? new URL(rawUrl, baseUrl).toString()
	);
}

function chapterPageUrl(baseUrl: string, chapterCode: string): string {
	return `${baseUrl}/laws/generallaws/chapter${chapterCode.toLowerCase()}`;
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
		const rootHtml = await fetchMglLandingHtml(startUrl);
		const versionId = extractVersionIdFromLandingHtml(rootHtml);

		await env.STORAGE.put(`sources/mgl/${versionId}/root.html`, rootHtml, {
			httpMetadata: { contentType: "text/html" },
		});

		const partSummaries = await fetchMglParts(env, versionId, env.MGL_BASE_URL);
		const units: MglUnitRoot[] = [];
		for (const summary of partSummaries) {
			const summaryPart = parsePartSummary(
				summary,
				getApiUrl(summary.Details, env.MGL_BASE_URL),
			);
			const detail = await fetchMglPart(
				env,
				versionId,
				env.MGL_BASE_URL,
				summaryPart.partCode,
			);
			const parsed = parsePartDetail(
				detail,
				getApiUrl(summary.Details, env.MGL_BASE_URL),
			);
			units.push({
				...parsed,
				id: `part-${parsed.partCode.toLowerCase()}`,
			});
		}

		units.sort((a, b) => a.sortOrder - b.sortOrder);

		return {
			versionId,
			rootNode: createRootNodePlan(versionId, startUrl),
			unitRoots: units,
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
			source_url: unit.partApiUrl,
			accessed_at: accessedAt,
		};

		shardItems.push({
			parentId: root.rootNode.id,
			childId: partId,
			sourceUrl: unit.partApiUrl,
			meta: { kind: "node", node: partNode },
		});

		const part = await fetchMglPart(
			env,
			root.versionId,
			env.MGL_BASE_URL,
			unit.partCode,
		);
		const chapterSummaries = [...part.Chapters].sort(
			(a, b) => designatorSortOrder(a.Code) - designatorSortOrder(b.Code),
		);

		for (const chapterSummary of chapterSummaries) {
			const chapterApiUrl = getApiUrl(chapterSummary.Details, env.MGL_BASE_URL);
			const chapterDetail = await fetchMglChapter(
				env,
				root.versionId,
				env.MGL_BASE_URL,
				chapterSummary.Code,
			);
			const chapter = parseChapterDetail(chapterDetail, chapterApiUrl);
			const chapterId = makeChapterId(partId, chapter.chapterCode);
			const publicChapterUrl =
				normalizeMglPublicUrl(chapterSummary.Details, env.MGL_BASE_URL) ??
				chapterPageUrl(env.MGL_BASE_URL, chapter.chapterCode);

			const chapterNode: NodeMeta = {
				id: chapterId,
				source_version_id: root.sourceVersionId,
				parent_id: partId,
				level_name: "chapter",
				level_index: 1,
				sort_order: chapter.sortOrder,
				name: normalizeName(chapter.chapterName),
				path: `/statutes/mgl/part/${unit.partCode.toLowerCase()}/chapter/${chapter.chapterCode.toLowerCase()}`,
				readable_id: `Chapter ${chapter.chapterCode}`,
				heading_citation: `Chapter ${chapter.chapterCode}`,
				source_url: publicChapterUrl,
				accessed_at: accessedAt,
			};

			shardItems.push({
				parentId: partId,
				childId: chapterId,
				sourceUrl: chapter.chapterApiUrl,
				meta: { kind: "node", node: chapterNode },
			});

			const sectionSummaries = [...chapterDetail.Sections].sort(
				(a, b) => designatorSortOrder(a.Code) - designatorSortOrder(b.Code),
			);
			for (const sectionSummary of sectionSummaries) {
				const section = parseSectionSummary(
					sectionSummary,
					getApiUrl(sectionSummary.Details, env.MGL_BASE_URL),
				);
				const sectionId = makeSectionId(chapterId, section.sectionCode);
				if (seenSectionIds.has(sectionId)) continue;
				seenSectionIds.add(sectionId);

				shardItems.push({
					parentId: chapterId,
					childId: sectionId,
					sourceUrl: section.sectionApiUrl,
					meta: {
						kind: "section",
						partCode: unit.partCode,
						chapterCode: chapter.chapterCode,
						sectionCode: section.sectionCode,
						sectionApiUrl: section.sectionApiUrl,
						sortOrder: section.sortOrder,
					},
				});
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
			const section = await fetchMglSection(
				env,
				root.versionId,
				env.MGL_BASE_URL,
				item.meta.chapterCode,
				item.meta.sectionCode,
			);
			const parsed = parseSectionContent(section);
			const crossReferences = extractSectionCrossReferences(parsed.body);
			const readableId = `MGL c.${item.meta.chapterCode} §${item.meta.sectionCode}`;
			const path = `/statutes/mgl/part/${item.meta.partCode.toLowerCase()}/chapter/${item.meta.chapterCode.toLowerCase()}/section/${item.meta.sectionCode.toLowerCase()}`;

			pendingWrites.push({
				node: {
					id: item.childId,
					source_version_id: sourceVersionId,
					parent_id: item.parentId,
					level_name: "section",
					level_index: SECTION_LEVEL_INDEX,
					sort_order: item.meta.sortOrder,
					name: parsed.heading,
					path,
					readable_id: readableId,
					heading_citation: readableId,
					source_url: item.meta.sectionApiUrl,
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
