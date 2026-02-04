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

export type NodeInsert = Omit<Node, "id">;

/** RPC interface for IngestRunner - used by container to call back to DO */
export interface IngestRunnerRpc {
	getOrCreateSource(
		code: string,
		name: string,
		jurisdiction: string,
		region: string,
		docType: string,
	): Promise<number>;
	getOrCreateSourceVersion(
		sourceId: number,
		versionDate: string,
	): Promise<number>;
	getLatestVersion(sourceId: number): Promise<SourceVersion | null>;
	loadBlobHashes(sourceId: number): Promise<Record<string, BlobLocation>>;
	insertNodesBatched(nodes: NodeInsert[]): Promise<Record<string, number>>;
	insertNode(
		versionId: number,
		stringId: string,
		parentId: number | null,
		levelName: string,
		levelIndex: number,
		sortOrder: number,
		name: string | null,
		path: string | null,
		readableId: string | null,
		headingCitation: string | null,
		blobHash: string | null,
		sourceUrl: string | null,
		accessedAt: string | null,
	): Promise<number>;
	insertBlobs(
		sourceId: number,
		packfileKey: string,
		entries: BlobEntry[],
	): Promise<void>;
	setRootNodeId(versionId: number, rootNodeId: number): Promise<void>;
	computeDiff(oldVersionId: number, newVersionId: number): Promise<DiffResult>;
}

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	GODADDY_CA?: Fetcher; // Only available in deployed workers
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	INGEST_RUNNER: DurableObjectNamespace;
	// R2 S3 API credentials (for container use)
	R2_S3_ACCOUNT_ID: string;
	R2_S3_ACCESS_KEY_ID: string;
	R2_S3_SECRET_ACCESS_KEY: string;
	R2_S3_BUCKET_NAME: string;
}

/** Environment available inside the container (no Workers bindings) */
export interface ContainerEnv {
	CGA_BASE_URL: string;
	CGA_START_PATH: string;
	USC_DOWNLOAD_BASE: string;
	R2_S3_ACCOUNT_ID: string;
	R2_S3_ACCESS_KEY_ID: string;
	R2_S3_SECRET_ACCESS_KEY: string;
	R2_S3_BUCKET_NAME: string;
}
