// Main exports for the ingestion library

export {
	extractSectionCrossReferences,
	type SectionCrossReference,
} from "./lib/cga/cross-references";
// CGA
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
	ensureSourceVersion,
	getLatestVersion,
	getNodeIdByStringId,
	getOrCreateSource,
	insertNode,
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
