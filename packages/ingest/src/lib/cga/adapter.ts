import type { Env } from "../../types";
import type {
	GenericWorkflowAdapter,
	NodePlan,
	RootPlan,
	ShardItem,
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

interface CgaUnitRoot {
	id: string;
	titleUrl: string;
}

type CgaShardMeta =
	| { kind: "node"; node: NodePlan }
	| { kind: "section"; sectionSlug: string };

function createRootNodePlan(versionId: string, startUrl: string): NodePlan {
	const accessedAt = new Date().toISOString();
	return {
		stringId: `${SOURCE_CODE}/${versionId}/root`,
		parentStringId: null,
		levelName: "root",
		levelIndex: -1,
		sortOrder: 0,
		name: SOURCE_NAME,
		path: "/statutes/cgs",
		readableId: "CGS",
		headingCitation: "CGS",
		sourceUrl: startUrl,
		accessedAt,
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
		const titleStringId = makeTitleId(
			root.rootNode.stringId,
			normalizedTitleId,
		);

		const titleNode: NodePlan = {
			stringId: titleStringId,
			parentStringId: root.rootNode.stringId,
			levelName: "title",
			levelIndex: 0,
			sortOrder: designatorSortOrder(normalizedTitleId),
			name: parsed.titleName || `Title ${normalizedTitleId}`,
			path: `/statutes/cgs/title/${normalizedTitleId}`,
			readableId: normalizedTitleId,
			headingCitation: `Title ${normalizedTitleId}`,
			sourceUrl: unit.titleUrl,
			accessedAt,
		};

		const shardItems: Array<ShardWorkItem<CgaShardMeta>> = [
			{
				parentStringId: root.rootNode.stringId,
				childStringId: titleStringId,
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
			const chapterNode: NodePlan = {
				stringId: chapterStringId,
				parentStringId: titleStringId,
				levelName: chapter.type,
				levelIndex: 1,
				sortOrder: designatorSortOrder(normalizedChapterId),
				name: parsedChapter.chapterTitle,
				path: `/statutes/cgs/${chapter.type}/${normalizedTitleId}/${normalizedChapterId}`,
				readableId: normalizedChapterId,
				headingCitation: `${chapterTypeLabel} ${normalizedChapterId}`,
				sourceUrl: chapter.url,
				accessedAt,
			};

			shardItems.push({
				parentStringId: titleStringId,
				childStringId: chapterStringId,
				sourceUrl: chapter.url,
				meta: { kind: "node", node: chapterNode },
			});

			for (const section of parsedChapter.sections) {
				const sectionStringId = makeSectionId(chapterStringId, section.slug);
				shardItems.push({
					parentStringId: chapterStringId,
					childStringId: sectionStringId,
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
	async loadShardItems({ env, root, items }): Promise<ShardItem[]> {
		const accessedAt = new Date().toISOString();
		const results: ShardItem[] = [];
		const itemsByUrl = new Map<string, Array<ShardWorkItem<CgaShardMeta>>>();

		for (const item of items) {
			if (item.meta.kind === "node") {
				results.push({ node: item.meta.node, content: null });
				continue;
			}

			const list = itemsByUrl.get(item.sourceUrl);
			if (list) {
				list.push(item);
			} else {
				itemsByUrl.set(item.sourceUrl, [item]);
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
			const sectionBySlug = new Map(
				sections.map((section) => [
					extractSectionSlug(section.stringId),
					section,
				]),
			);

			for (const item of urlItems) {
				if (item.meta.kind !== "section") {
					continue;
				}

				const section = sectionBySlug.get(item.meta.sectionSlug);
				if (!section) {
					throw new Error(
						`Missing section ${item.meta.sectionSlug} in ${sourceUrl}`,
					);
				}

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

				results.push({
					node: {
						stringId: item.childStringId,
						parentStringId: item.parentStringId,
						levelName: section.levelName,
						levelIndex: section.levelIndex,
						sortOrder: section.sortOrder,
						name: section.name,
						path: section.path,
						readableId: section.readableId,
						headingCitation: section.readableId
							? `CGS § ${section.readableId}`
							: null,
						sourceUrl: section.sourceUrl,
						accessedAt,
					},
					content,
				});
			}
		}

		return results;
	},
};

export type { CgaUnitRoot, CgaShardMeta };
