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

export interface GenericWorkflowParams {
	/** Force re-ingestion even if version exists */
	force?: boolean;
	/** Process only a single unit by id */
	unitId?: string;
}

export interface VectorWorkflowParams extends GenericWorkflowParams {
	sourceId?: string;
	sourceVersionId?: string;
	batchSize?: number;
}

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	AI: Ai;
	VECTOR_SEARCH_INDEX: Vectorize;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	MGL_BASE_URL: string;
	MGL_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	INGEST_RUNNER: DurableObjectNamespace;
	CGA_WORKFLOW: Workflow<GenericWorkflowParams>;
	MGL_WORKFLOW: Workflow<GenericWorkflowParams>;
	USC_WORKFLOW: Workflow<GenericWorkflowParams>;
	VECTOR_WORKFLOW: Workflow<VectorWorkflowParams>;
}
