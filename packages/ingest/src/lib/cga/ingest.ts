import type { Env, IngestionResult, ParsedSection } from "../../types";
import {
	computeDiff,
	getLatestVersion,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "../versioning";
import {
	crawlCGA,
	getChapterIdFromUrl,
	getTitleIdFromUrl,
	isChapterUrl,
	isTitleUrl,
} from "./crawler";
import {
	extractChapterTitle,
	extractSectionsFromHtml,
	formatDesignatorDisplay,
	formatDesignatorPadded,
	normalizeDesignator,
} from "./parser";

const SOURCE_CODE = "cgs";
const SOURCE_NAME = "Connecticut General Statutes";

interface TitleInfo {
	titleId: string;
	titleName: string | null;
	sourceUrl: string;
}

interface ChapterInfo {
	chapterId: string;
	chapterTitle: string | null;
	titleId: string;
	sourceUrl: string;
}

/**
 * Main CGA ingestion function
 */
export async function ingestCGA(env: Env): Promise<IngestionResult> {
	const startUrl = `${env.CGA_BASE_URL}${env.CGA_START_PATH}`;
	const accessedAt = new Date().toISOString();

	// Get or create source
	const sourceId = await getOrCreateSource(
		env.DB,
		SOURCE_CODE,
		SOURCE_NAME,
		"state",
		"CT",
		"statute",
	);

	// Get latest version for diff comparison
	const previousVersion = await getLatestVersion(env.DB, sourceId);

	// Create new version
	const versionDate = new Date().toISOString().split("T")[0];
	const versionId = await getOrCreateSourceVersion(env.DB, sourceId, versionDate);

	// Crawl CGA website
	console.log(`Starting CGA crawl from ${startUrl}`);
	const pages = await crawlCGA(startUrl, env.GODADDY_CA, 2000, 50);
	console.log(`Crawled ${pages.size} pages`);

	// Extract titles and chapters
	const titles = new Map<string, TitleInfo>();
	const chapters = new Map<string, ChapterInfo>();
	const allSections: ParsedSection[] = [];

	// First pass: extract title info from title_*.htm files
	for (const [url, html] of pages) {
		if (isTitleUrl(url)) {
			const rawTitleId = getTitleIdFromUrl(url);
			if (!rawTitleId) continue;

			const titleId = normalizeDesignator(rawTitleId) || rawTitleId;
			const titleName = extractTitleName(html);

			titles.set(titleId, {
				titleId,
				titleName,
				sourceUrl: url,
			});
		}
	}

	// Second pass: extract chapters and sections from chap_*.htm files
	for (const [url, html] of pages) {
		if (isChapterUrl(url)) {
			const chapterId = getChapterIdFromUrl(url);
			if (!chapterId) continue;

			const chapterTitle = extractChapterTitle(html);
			const sections = extractSectionsFromHtml(html, chapterId, url);

			// Determine title from first section
			let titleId: string | null = null;
			if (sections.length > 0) {
				const firstSection = sections[0];
				// Extract title from section's string_id pattern
				const match = firstSection.slug.match(
					/statutes\/cgs\/section\/([^/]+)/,
				);
				if (match) {
					titleId = match[1];
				}
			}

			if (titleId) {
				chapters.set(chapterId, {
					chapterId,
					chapterTitle,
					titleId,
					sourceUrl: url,
				});

				// Update sections with correct parentStringId
				for (const section of sections) {
					section.parentStringId = `cgs/chapter/${chapterId}`;
					allSections.push(section);
				}
			}
		}
	}

	console.log(
		`Found ${titles.size} titles, ${chapters.size} chapters, ${allSections.length} sections`,
	);

	// Insert nodes into database
	let nodesCreated = 0;
	const nodeIdMap = new Map<string, number>();

	// Insert root node for source
	const rootStringId = `cgs/root`;
	const rootNodeId = await insertNode(
		env.DB,
		versionId,
		rootStringId,
		null,
		"root",
		-1,
		0,
		SOURCE_NAME,
		SOURCE_NAME,
		"statutes/cgs",
		null,
		null,
		null,
		startUrl,
		accessedAt,
	);
	nodeIdMap.set(rootStringId, rootNodeId);
	nodesCreated++;

	// Insert titles
	const sortedTitles = [...titles.values()].sort((a, b) => {
		const aPadded = formatDesignatorPadded(a.titleId) || a.titleId;
		const bPadded = formatDesignatorPadded(b.titleId) || b.titleId;
		return aPadded.localeCompare(bPadded);
	});

	for (let i = 0; i < sortedTitles.length; i++) {
		const title = sortedTitles[i];
		const stringId = `cgs/title/${title.titleId}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			rootNodeId,
			"title",
			0,
			i,
			formatDesignatorDisplay(title.titleId),
			title.titleName,
			`statutes/cgs/title/${title.titleId}`,
			null,
			null,
			null,
			title.sourceUrl,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert chapters
	const sortedChapters = [...chapters.values()].sort((a, b) => {
		const aKey = `${formatDesignatorPadded(a.titleId)}-${formatDesignatorPadded(a.chapterId.replace("chap_", ""))}`;
		const bKey = `${formatDesignatorPadded(b.titleId)}-${formatDesignatorPadded(b.chapterId.replace("chap_", ""))}`;
		return aKey.localeCompare(bKey);
	});

	for (let i = 0; i < sortedChapters.length; i++) {
		const chapter = sortedChapters[i];
		const titleStringId = `cgs/title/${chapter.titleId}`;
		const parentId = nodeIdMap.get(titleStringId) || null;

		const chapterNum = chapter.chapterId.replace("chap_", "");
		const stringId = `cgs/chapter/${chapter.chapterId}`;
		const nodeId = await insertNode(
			env.DB,
			versionId,
			stringId,
			parentId,
			"chapter",
			1,
			i,
			formatDesignatorDisplay(chapterNum),
			chapter.chapterTitle,
			`statutes/cgs/chapter/${chapter.titleId}/${chapter.chapterId}`,
			null,
			null,
			null,
			chapter.sourceUrl,
			accessedAt,
		);
		nodeIdMap.set(stringId, nodeId);
		nodesCreated++;
	}

	// Insert sections and store content in R2
	for (let i = 0; i < allSections.length; i++) {
		const section = allSections[i];
		const parentId = section.parentStringId
			? nodeIdMap.get(section.parentStringId) || null
			: null;

		// Create content JSON
		const content = {
			version: 2,
			doc_id: `doc_${section.stringId.replace(/\//g, "_")}`,
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
					? [
							{
								type: "citations",
								label: "Citations",
								content: section.citations,
							},
						]
					: []),
			],
		};

		// Store in R2
		const blobKey = `${section.slug}.json`;
		const contentJson = JSON.stringify(content);
		await env.STORAGE.put(blobKey, contentJson);

		// Insert node with blob reference
		const nodeId = await insertNode(
			env.DB,
			versionId,
			section.stringId,
			parentId,
			section.levelName,
			section.levelIndex,
			i,
			section.label,
			section.name,
			section.slug,
			blobKey,
			0,
			contentJson.length,
			section.sourceUrl,
			accessedAt,
		);
		nodeIdMap.set(section.stringId, nodeId);
		nodesCreated++;

		if (nodesCreated % 100 === 0) {
			console.log(`Created ${nodesCreated} nodes...`);
		}
	}

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

/**
 * Extract title name from title_*.htm HTML
 */
function extractTitleName(html: string): string | null {
	const titleMatch = html.match(/<title>(.*?)<\/title>/is);
	if (!titleMatch) return null;

	const titleText = titleMatch[1].replace(/<[^>]+>/g, "");
	const decoded = decodeHtmlEntities(titleText).trim();

	// Try to extract name from "Title X - Name" format
	const match = decoded.match(/^Title\s+[\w]+?\s*-\s*(.+)$/i);
	if (match) {
		return match[1].trim() || null;
	}

	return null;
}

function decodeHtmlEntities(text: string): string {
	const entities: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '"',
		"&#39;": "'",
		"&apos;": "'",
		"&nbsp;": " ",
	};
	return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
}
