// D1 Database Types - New unified schema

export interface SourceRecord {
	id: number;
	code: string;
	name: string;
	jurisdiction: string;
	region: string;
	doc_type: string;
}

export interface SourceVersionRecord {
	id: number;
	source_id: number;
	canonical_name: string;
	version_date: string;
	root_node_id: number | null;
	created_at: string | null;
}

// Unified node record - replaces LevelRecord, DocumentRecord, TitleRecord, etc.
export interface NodeRecord {
	id: number;
	source_version_id: number;
	string_id: string;
	readable_id: string | null;
	parent_id: number | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	label: string | null;
	path: string | null;
	blob_key: string | null;
	blob_offset: number | null;
	blob_size: number | null;
	source_url: string | null;
	accessed_at: string | null;
}

// Extended node with source info for convenience
export interface NodeWithSource extends NodeRecord {
	source_code: string;
	source_name: string;
}

// Alias for backwards compatibility - LevelRecord is now NodeRecord
export type LevelRecord = NodeRecord;

export type PageData =
	| { status: "missing"; path: string }
	| {
			status: "found";
			path: string;
			node: NodeRecord;
			source: SourceRecord;
			sourceVersion: SourceVersionRecord;
			ancestors: NodeRecord[];
			content?: NodeContent;
			nav?: { prev: NodeRecord | null; next: NodeRecord | null };
			children?: NodeRecord[];
	  };

// Backwards compatibility alias
export type LevelPageData = PageData;

// R2 Content Types

export interface ContentBlock {
	type: string;
	label?: string;
	content: string;
}

// Generic node content stored in R2 blobs
export interface NodeContent {
	version: 1 | 2;
	node_id?: string;
	string_id?: string;
	doc_type?: "statute" | "regulation" | "case";
	blocks: ContentBlock[];
	metadata?: {
		citations?: string[];
		parties?: string[];
		court?: string;
		docket?: string;
		decision_date?: string;
		agency?: string;
		source?: string;
	};
}

// Legacy aliases for backwards compatibility
export type SectionContent = NodeContent;
export type DocumentContent = NodeContent;

// Cloudflare Environment

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	PINECONE_API_KEY: string;
	PINECONE_INDEX_NAME: string;
	PINECONE_INDEX_HOST?: string;
	PINECONE_NAMESPACE?: string;
	PINECONE_API_VERSION: string;
	PINECONE_EMBED_ENDPOINT: string;
	PINECONE_EMBED_MODEL: string;
	PINECONE_EMBED_DIMENSION: string;
	PINECONE_TOP_K?: string;
	READ_MAX_TOKENS: string;
	AGENT_MAX_STEPS: string;
	GEMINI_API_KEY: string;
	GEMINI_MODEL: string;
}
