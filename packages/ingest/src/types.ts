export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
}

export interface Source {
	id: number;
	code: string;
	name: string;
	jurisdiction: string;
	region: string;
	doc_type: string;
}

export interface SourceVersion {
	id: number;
	source_id: number;
	canonical_name: string;
	version_date: string;
	root_node_id: number | null;
	created_at: string;
}

export interface NodeMeta {
	id: number;
	source_version_id: number;
	string_id: string;
	parent_id: number | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	name: string | null;
	path: string | null;
	readable_id: string | null;
	source_url: string | null;
	accessed_at: string | null;
}

export interface Node extends NodeMeta {
	blob_hash: bigint | null;
}

export interface DiffResult {
	added: string[];
	removed: string[];
	modified: string[];
}

export interface IngestionResult {
	sourceVersionId: number;
	nodesCreated: number;
	diff: DiffResult | null;
}
