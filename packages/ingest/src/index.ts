// Main exports for the ingestion library

export {
	crawlCGA,
	extractLinks,
	getChapterIdFromUrl,
	getTitleIdFromUrl,
	isChapterUrl,
	isTitleUrl,
} from "./lib/cga/crawler";
// CGA
export { ingestCGA } from "./lib/cga/ingest";
export {
	extractChapterTitle as extractCGAChapterTitle,
	extractSectionsFromHtml as extractCGASections,
	formatDesignatorDisplay,
	formatDesignatorPadded,
	normalizeDesignator,
} from "./lib/cga/parser";
export {
	fetchAllUSCTitles,
	fetchUSCFromR2,
	fetchUSCTitle,
	getTitleNumFromUrl,
	getUSCTitleUrls,
} from "./lib/usc/fetcher";
// USC
export { ingestUSC } from "./lib/usc/ingest";
export {
	chapterSortKey,
	parseUSCXml,
	sectionSortKey,
	titleSortKey,
} from "./lib/usc/parser";
// Versioning
export {
	computeDiff,
	getLatestVersion,
	getNodeIdByStringId,
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	setRootNodeId,
} from "./lib/versioning";
// Types
export type {
	DiffResult,
	Env,
	IngestionResult,
	Node,
	ParsedLevel,
	ParsedSection,
	Source,
	SourceVersion,
} from "./types";
