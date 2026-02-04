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

export interface SourceVersion {
	id: number;
	source_id: number;
	canonical_name: string;
	version_date: string;
	root_node_id: number | null;
	created_at: string;
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

export interface NodeInsert {
	source_version_id: number;
	string_id: string;
	parent_id: number | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	name: string | null;
	path: string | null;
	readable_id: string | null;
	heading_citation: string | null;
	blob_hash: string | null;
	source_url: string | null;
	accessed_at: string | null;
}

export interface ContainerEnv {
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	R2_S3_ACCOUNT_ID: string;
	R2_S3_ACCESS_KEY_ID: string;
	R2_S3_SECRET_ACCESS_KEY: string;
	R2_S3_BUCKET_NAME: string;
}
