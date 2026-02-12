import type { IngestContainer } from "./lib/ingest-container";
import type { PackfileDO } from "./lib/packfile-do";

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

export interface NodePayload {
	meta: NodeMeta;
	content: unknown | null;
}

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

export type IngestSourceCode = string;

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	INGEST_CONTAINER: DurableObjectNamespace<IngestContainer>;
	PACKFILE_DO: DurableObjectNamespace<PackfileDO>;
	AI: Ai;
	VECTOR_SEARCH_INDEX: Vectorize;
	USC_DOWNLOAD_BASE: string;
	CALLBACK_SECRET: string;
	VECTOR_WORKFLOW: Workflow<VectorWorkflowParams>;
	// CGA/MGL adapters (unhooked from worker, kept for future use)
	GODADDY_CA: Fetcher;
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	MGL_BASE_URL: string;
	MGL_START_PATH: string;
}
