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
// Versioning
export {
	computeDiff,
	ensureSourceVersion,
	getLatestVersion,
	getNodeIdByStringId,
	getOrCreateSource,
	insertNode,
} from "./lib/versioning";
// Zip utils
export { streamXmlFromZip, streamXmlFromZipStream } from "./lib/zip-utils";
// Types
export type {
	DiffResult,
	Env,
	IngestionResult,
	IngestNode,
	NodeMeta,
	Source,
	SourceVersion,
	VectorWorkflowParams,
} from "./types";
