export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
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

export interface Node {
	id: number;
	source_version_id: number;
	string_id: string;
	parent_id: number | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	label: string | null;
	name: string | null;
	slug: string | null;
	blob_key: string | null;
	blob_offset: number | null;
	blob_size: number | null;
	source_url: string | null;
	accessed_at: string | null;
}

export interface ParsedSection {
	stringId: string;
	levelName: string;
	levelIndex: number;
	label: string;
	name: string | null;
	slug: string;
	body: string;
	historyShort: string | null;
	historyLong: string | null;
	citations: string | null;
	parentStringId: string | null;
	sortOrder: number;
	sourceUrl: string;
}

export interface ParsedLevel {
	stringId: string;
	levelName: string;
	levelIndex: number;
	label: string;
	name: string | null;
	slug: string;
	parentStringId: string | null;
	sortOrder: number;
	sourceUrl: string;
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
