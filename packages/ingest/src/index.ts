// Main exports for the ingestion library

export {
	crawlCGA,
	getChapterIdFromUrl,
	getTitleIdFromUrl,
	isChapterUrl,
	isTitleUrl,
} from "./lib/cga/crawler";
export {
	extractSectionCrossReferences,
	type SectionCrossReference,
} from "./lib/cga/cross-references";
// CGA
export { ingestCGA } from "./lib/cga/ingest";
export {
	extractChapterTitle as extractCGAChapterTitle,
	extractLinks,
	formatDesignatorDisplay,
	formatDesignatorPadded,
	normalizeDesignator,
} from "./lib/cga/parser";
export {
	fetchUSCTitleStreaming,
	getTitleNumFromUrl,
	getUSCTitleUrls,
	streamXmlFromZip,
} from "./lib/usc/fetcher";
// USC
export { ingestUSC } from "./lib/usc/ingest";
export {
	levelSortKey,
	parseUSCXml,
	sectionSortKey,
	streamUSCXml,
	streamUSCXmlFromChunks,
	titleSortKey,
	USC_LEVEL_HIERARCHY,
	USC_LEVEL_INDEX,
	type USCLevel,
	type USCLevelType,
} from "./lib/usc/parser";
// Versioning
export {
	computeDiff,
	ensureSourceVersion as getOrCreateSourceVersion,
	getLatestVersion,
	getNodeIdByStringId,
	getOrCreateSource,
	insertNode,
	setRootNodeId,
} from "./lib/versioning";
// Types
export type {
	DiffResult,
	Env,
	IngestionResult,
	IngestNode,
	NodeMeta,
	Source,
	SourceVersion,
} from "./types";
