import type { Env, NodeMeta } from "../../types";
import type {
	GenericWorkflowAdapter,
	RootPlan,
	ShardWorkItem,
	UnitPlan,
} from "../workflows/generic";
import { extractSectionCrossReferences } from "./cross-references";
import { normalizeDesignator } from "./parser";
import {
	buildSectionContent,
	designatorSortOrder,
	extractFilename,
	extractTitleUrls,
	extractVersionId,
	fetchWithCache,
	parseChapterPageForWorkflow,
	parseSectionsInRange,
	parseTitlePageForWorkflow,
} from "./workflow-helpers";

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";
const BLOB_STORE_BATCH_SIZE = 50;

interface CgaUnitRoot {
	id: string;
	titleUrl: string;
}

type CgaShardMeta =
	| { kind: "node"; node: NodeMeta }
	| { kind: "section"; sectionSlug: string };
type CgaSectionShardItem = ShardWorkItem<
	Extract<CgaShardMeta, { kind: "section" }>
>;

function createRootNodePlan(versionId: string, startUrl: string): NodeMeta {
	const accessedAt = new Date().toISOString();
	return {
		id: `${SOURCE_CODE}/${versionId}/root`,
		source_version_id: "",
		parent_id: null,
		level_name: "root",
		level_index: -1,
		sort_order: 0,
		name: SOURCE_NAME,
		path: "/statutes/cgs",
		readable_id: "CGS",
		heading_citation: "CGS",
		source_url: startUrl,
		accessed_at: accessedAt,
	};
}

function makeTitleId(rootId: string, titleId: string): string {
	return `${rootId}/title-${titleId}`;
}

function makeChapterId(
	titleId: string,
	type: "chapter" | "article",
	chapterId: string,
): string {
	return `${titleId}/${type}-${chapterId}`;
}

function extractSectionSlug(sectionStringId: string): string {
	const parts = sectionStringId.split("/");
	return parts[parts.length - 1] || sectionStringId;
}

function makeSectionId(chapterId: string, sectionStringId: string): string {
	const slug = extractSectionSlug(sectionStringId);
	return `${chapterId}/section-${slug}`;
}

async function readStreamToString(
	body: ReadableStream<Uint8Array>,
): Promise<string> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let html = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		html += decoder.decode(value, { stream: true });
	}
	html += decoder.decode();
	return html;
}

async function loadChapterHtml(
	env: Env,
	versionId: string,
	chapterUrl: string,
): Promise<string> {
	const r2Key = `sources/cga/${versionId}/${extractFilename(chapterUrl)}`;
	const cached = await env.STORAGE.get(r2Key);
	if (cached) {
		return await cached.text();
	}

	const { body } = await fetchWithCache(
		chapterUrl,
		versionId,
		env.STORAGE,
		env.GODADDY_CA,
	);
	return await readStreamToString(body);
}

export const cgaAdapter: GenericWorkflowAdapter<CgaUnitRoot, CgaShardMeta> = {
	source: {
		code: SOURCE_CODE,
		name: SOURCE_NAME,
		jurisdiction: "state",
		region: "CT",
		docType: "statute",
	},
	async discoverRoot({ env }): Promise<RootPlan<CgaUnitRoot>> {
		const startUrl = `${env.CGA_BASE_URL}${env.CGA_START_PATH}`;
		const response = await fetch(startUrl, {
			headers: {
				"User-Agent": "fastlaw-ingest/1.0",
				Accept: "text/html,application/xhtml+xml",
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to fetch root page: ${response.status}`);
		}
		const html = await response.text();
		const versionId = extractVersionId(html);

		await env.STORAGE.put(`sources/cga/${versionId}/titles.htm`, html, {
			httpMetadata: { contentType: "text/html" },
		});

		const titleUrls = extractTitleUrls(html, startUrl);
		const unitRoots = titleUrls.map((titleUrl) => ({
			id: extractFilename(titleUrl).replace(/\.htm$/i, ""),
			titleUrl,
		}));

		return {
			versionId,
			rootNode: createRootNodePlan(versionId, startUrl),
			unitRoots,
		};
	},
	async planUnit({ env, root, unit }): Promise<UnitPlan<CgaShardMeta>> {
		const { body } = await fetchWithCache(
			unit.titleUrl,
			root.versionId,
			env.STORAGE,
			env.GODADDY_CA,
		);

		const parsed = await parseTitlePageForWorkflow(body, unit.titleUrl);
		const normalizedTitleId =
			normalizeDesignator(parsed.titleId) || parsed.titleId;
		const accessedAt = new Date().toISOString();
		const titleStringId = makeTitleId(root.rootNode.id, normalizedTitleId);

		const titleNode: NodeMeta = {
			id: titleStringId,
			source_version_id: root.sourceVersionId,
			parent_id: root.rootNode.id,
			level_name: "title",
			level_index: 0,
			sort_order: designatorSortOrder(normalizedTitleId),
			name: parsed.titleName || `Title ${normalizedTitleId}`,
			path: `/statutes/cgs/title/${normalizedTitleId}`,
			readable_id: normalizedTitleId,
			heading_citation: `Title ${normalizedTitleId}`,
			source_url: unit.titleUrl,
			accessed_at: accessedAt,
		};

		const shardItems: Array<ShardWorkItem<CgaShardMeta>> = [
			{
				parentId: root.rootNode.id,
				childId: titleStringId,
				sourceUrl: unit.titleUrl,
				meta: { kind: "node", node: titleNode },
			},
		];

		for (const chapter of parsed.chapterUrls) {
			const { body: chapterBody } = await fetchWithCache(
				chapter.url,
				root.versionId,
				env.STORAGE,
				env.GODADDY_CA,
			);

			const parsedChapter = await parseChapterPageForWorkflow(
				chapterBody,
				chapter.url,
				chapter.type,
			);
			const normalizedChapterId =
				normalizeDesignator(parsedChapter.chapterId) || parsedChapter.chapterId;
			const chapterTypeLabel =
				chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);
			const chapterStringId = makeChapterId(
				titleStringId,
				chapter.type,
				normalizedChapterId,
			);
			const chapterNode: NodeMeta = {
				id: chapterStringId,
				source_version_id: root.sourceVersionId,
				parent_id: titleStringId,
				level_name: chapter.type,
				level_index: 1,
				sort_order: designatorSortOrder(normalizedChapterId),
				name: parsedChapter.chapterTitle,
				path: `/statutes/cgs/${chapter.type}/${normalizedTitleId}/${normalizedChapterId}`,
				readable_id: normalizedChapterId,
				heading_citation: `${chapterTypeLabel} ${normalizedChapterId}`,
				source_url: chapter.url,
				accessed_at: accessedAt,
			};

			shardItems.push({
				parentId: titleStringId,
				childId: chapterStringId,
				sourceUrl: chapter.url,
				meta: { kind: "node", node: chapterNode },
			});

			for (const section of parsedChapter.sections) {
				const sectionStringId = makeSectionId(chapterStringId, section.slug);
				shardItems.push({
					parentId: chapterStringId,
					childId: sectionStringId,
					sourceUrl: chapter.url,
					meta: { kind: "section", sectionSlug: section.slug },
				});
			}
		}

		return {
			unitId: `title-${normalizedTitleId}`,
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
		const itemsByUrl = new Map<string, CgaSectionShardItem[]>();

		for (const item of items) {
			if (item.meta.kind === "node") {
				await nodeStore.store(item.meta.node, null);
				continue;
			}

			const list = itemsByUrl.get(item.sourceUrl);
			if (list) {
				list.push(item as CgaSectionShardItem);
			} else {
				itemsByUrl.set(item.sourceUrl, [item as CgaSectionShardItem]);
			}
		}

		for (const [sourceUrl, urlItems] of itemsByUrl) {
			const html = await loadChapterHtml(env, root.versionId, sourceUrl);
			const sections = await parseSectionsInRange(
				html,
				sourceUrl,
				0,
				Number.MAX_SAFE_INTEGER,
			);
			const sectionItemBySlug = new Map(
				urlItems.map((item) => [item.meta.sectionSlug, item] as const),
			);
			const pendingWrites: Array<{
				node: NodeMeta;
				content: unknown;
			}> = [];
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

			for (const section of sections) {
				const slug = extractSectionSlug(section.stringId);
				const item = sectionItemBySlug.get(slug);
				if (!item) continue;

				const crossReferences = extractSectionCrossReferences(
					[section.body, section.seeAlso].filter(Boolean).join("\n"),
				);
				const content = buildSectionContent(section) as {
					metadata?: { cross_references: typeof crossReferences };
				};
				if (crossReferences.length > 0) {
					content.metadata = {
						cross_references: crossReferences,
					};
				}

				pendingWrites.push({
					node: {
						id: item.childId,
						source_version_id: sourceVersionId,
						parent_id: item.parentId,
						level_name: section.levelName,
						level_index: section.levelIndex,
						sort_order: section.sortOrder,
						name: section.name,
						path: section.path,
						readable_id: section.readableId,
						heading_citation: section.readableId
							? `CGS § ${section.readableId}`
							: null,
						source_url: section.sourceUrl,
						accessed_at: accessedAt,
					},
					content,
				});
				if (pendingWrites.length >= BLOB_STORE_BATCH_SIZE) {
					await flushPendingWrites();
				}

				sectionItemBySlug.delete(slug);
			}
			await flushPendingWrites();

			if (sectionItemBySlug.size > 0) {
				const missingSlug = sectionItemBySlug.keys().next().value;
				throw new Error(`Missing section ${missingSlug} in ${sourceUrl}`);
			}
		}
	},
};

export type { CgaUnitRoot, CgaShardMeta };
