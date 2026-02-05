import type { Env } from "../../types";
import type {
	GenericWorkflowAdapter,
	NodePlan,
	RootPlan,
	ShardItem,
	ShardPlan,
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

interface ChapterShardInput {
	kind: "chapter";
	chapterUrl: string;
	chapterType: "chapter" | "article";
	chapterId: string;
	titleId: string;
	chapterStringId: string;
}

interface TitleShardInput {
	kind: "title";
	titleStringId: string;
}

type CgaShardInput = ChapterShardInput | TitleShardInput;

type ChapterShardMeta =
	| { kind: "title"; node: NodePlan }
	| { kind: "chapter"; node: NodePlan; chapterUrl: string };

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

export const cgaAdapter: GenericWorkflowAdapter<
	CgaUnitRoot,
	CgaShardInput,
	ChapterShardMeta
> = {
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
	async planUnit({ env, root, unit }): Promise<UnitPlan<CgaShardInput>> {
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

		const chapterNodes: NodePlan[] = [];
		const shardInputs: CgaShardInput[] = [{ kind: "title", titleStringId }];

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
			chapterNodes.push({
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
			});

			shardInputs.push({
				kind: "chapter",
				chapterUrl: chapter.url,
				chapterType: chapter.type,
				chapterId: normalizedChapterId,
				titleId: normalizedTitleId,
				chapterStringId,
			});
		}

		return {
			unitId: `title-${normalizedTitleId}`,
			structuralNodes: [titleNode, ...chapterNodes],
			shardInputs,
		};
	},
	async planShards({ unitPlan }): Promise<Array<ShardPlan<ChapterShardMeta>>> {
		const nodeById = new Map(
			unitPlan.structuralNodes.map((node) => [node.stringId, node]),
		);

		return unitPlan.shardInputs.map((input, index) => {
			if (input.kind === "title") {
				const node = nodeById.get(input.titleStringId);
				if (!node) {
					throw new Error(`Missing title node for ${input.titleStringId}`);
				}
				return {
					key: `title-${index}`,
					meta: { kind: "title", node },
				};
			}

			const node = nodeById.get(input.chapterStringId);
			if (!node) {
				throw new Error(`Missing chapter node for ${input.chapterStringId}`);
			}
			return {
				key: `${input.chapterId}-${index}`,
				meta: {
					kind: "chapter",
					node,
					chapterUrl: input.chapterUrl,
				},
			};
		});
	},
	async loadShardItems({ env, root, shard }): Promise<ShardItem[]> {
		const accessedAt = new Date().toISOString();
		if (shard.meta.kind === "title") {
			return [
				{
					node: shard.meta.node,
					content: null,
				},
			];
		}

		const html = await loadChapterHtml(
			env,
			root.versionId,
			shard.meta.chapterUrl,
		);
		const sections = await parseSectionsInRange(
			html,
			shard.meta.chapterUrl,
			0,
			Number.MAX_SAFE_INTEGER,
		);

		const chapterNode = shard.meta.node;
		const chapterItem: ShardItem = {
			node: chapterNode,
			content: null,
		};

		const sectionItems = sections.map((section, index) => {
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

			const sectionId = makeSectionId(chapterNode.stringId, section.stringId);
			return {
				node: {
					stringId: sectionId,
					parentStringId: chapterNode.stringId,
					levelName: section.levelName,
					levelIndex: section.levelIndex,
					sortOrder: section.sortOrder ?? index,
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
			};
		});

		return [chapterItem, ...sectionItems];
	},
};

export type { CgaUnitRoot, CgaShardInput, ChapterShardMeta, ChapterShardInput };
