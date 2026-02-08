export interface BlobLocation {
	packfileKey: string;
	offset: number;
	size: number;
}

export interface BlobEntry {
	hash: string;
	offset: number;
	size: number;
}

export interface Source {
	id: string;
	name: string;
	jurisdiction: string;
	region: string;
	doc_type: string;
}

export interface SourceVersion {
	id: string;
	source_id: string;
	version_date: string;
	root_node_id: string | null;
	created_at: string;
}

export interface NodeMeta {
	id: string;
	source_version_id: string;
	parent_id: string | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	name: string | null;
	path: string | null;
	readable_id: string | null;
	heading_citation: string | null;
	source_url: string | null;
	accessed_at: string | null;
}

export interface IngestNode extends NodeMeta {
	blob_hash: string | null;
}

export type NodeInsert = IngestNode;

export interface DiffResult {
	added: string[];
	removed: string[];
	modified: string[];
}

export interface IngestionResult {
	sourceVersionId: string;
	nodesCreated: number;
	diff: DiffResult | null;
}

export interface VectorWorkflowParams {
	force?: boolean;
	sourceId?: string;
	sourceVersionId?: string;
	batchSize?: number;
}

export type IngestSourceCode = "cgs" | "mgl" | "usc";

export type IngestQueueShardWorkItem = {
	parentId: string;
	childId: string;
	sourceUrl: string;
	meta: unknown;
};

export interface IngestShardQueueMessage {
	kind: "ingest-shard";
	jobId: string;
	sourceCode: IngestSourceCode;
	sourceId: string;
	sourceVersionId: string;
	unit: unknown;
	items: IngestQueueShardWorkItem[];
}

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	INGEST_SHARDS_QUEUE: Queue<IngestShardQueueMessage>;
	AI: Ai;
	VECTOR_SEARCH_INDEX: Vectorize;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	MGL_BASE_URL: string;
	MGL_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	VECTOR_WORKFLOW: Workflow<VectorWorkflowParams>;
}

export type IngestQueueMessage = IngestShardQueueMessage;
