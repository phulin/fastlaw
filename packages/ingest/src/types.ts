export interface DatabaseClient {
	prepare(sql: string): PreparedStatement;
	batch(statements: PreparedStatement[]): Promise<DbBatchResult[]>;
}

export interface PreparedStatement {
	bind(...params: unknown[]): PreparedStatement;
	run(): Promise<DbRunResult>;
	all<T = unknown>(): Promise<DbAllResult<T>>;
	first<T = unknown>(): Promise<T | null>;
}

export interface DbRunResult {
	meta: {
		last_row_id?: number;
	};
}

export interface DbBatchResult {
	meta: {
		last_row_id?: number;
	};
}

export interface DbAllResult<T> {
	results: T[];
}

export interface ObjectStoreGetOptions {
	range?: {
		offset: number;
		length: number;
	};
}

export interface ObjectStoreBody {
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

export interface ObjectStoreListResult {
	objects: {
		key: string;
		size: number;
		etag: string;
		uploaded: string;
	}[];
	truncated: boolean;
	cursor?: string;
}

export interface ObjectStore {
	get(
		key: string,
		options?: ObjectStoreGetOptions,
	): Promise<ObjectStoreBody | null>;
	put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<void>;
	list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<ObjectStoreListResult>;
	delete(keys: string[]): Promise<void>;
}

export interface IngestContext {
	db: DatabaseClient;
	storage: ObjectStore;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
}

export interface WorkerEnv {
	DB: D1Database;
	STORAGE: R2Bucket;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	INGEST_CONTAINER: DurableObjectNamespace;
	PROGRESS_DO: DurableObjectNamespace;
	CF_ACCOUNT_ID: string;
	D1_DATABASE_ID: string;
	D1_API_TOKEN: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_BUCKET_NAME: string;
	INGEST_WORKER_URL: string;
}

export interface ContainerEnv {
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	CF_ACCOUNT_ID: string;
	D1_DATABASE_ID: string;
	D1_API_TOKEN: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_BUCKET_NAME: string;
	INGEST_WORKER_URL: string;
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
	heading_citation: string | null;
	source_url: string | null;
	accessed_at: string | null;
}

export interface Node extends NodeMeta {
	blob_hash: string | null;
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

export interface IngestJob {
	id: string;
	source: string;
	status: "queued" | "running" | "succeeded" | "failed";
	progress: number;
	message: string | null;
	started_at: string | null;
	updated_at: string | null;
	finished_at: string | null;
	result_json: string | null;
	error_json: string | null;
}
