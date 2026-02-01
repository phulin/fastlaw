// D1 Database Types

export interface TitleRecord {
	id: string;
	id_padded: string | null;
	id_display: string | null;
	name: string | null;
	sort_order: number;
}

export interface TitleSummary extends TitleRecord {
	chapter_count: number;
	section_count: number;
}

export interface ChapterRecord {
	id: string;
	id_padded: string | null;
	id_display: string | null;
	title_id: string;
	title_id_padded: string | null;
	title_id_display: string | null;
	name: string;
	section_count: number;
	section_start: string | null;
	section_end: string | null;
	sort_order: number;
}

export interface SectionRecord {
	id: string;
	title_id: string;
	chapter_id: string | null;
	section_number: string;
	section_label: string | null;
	heading: string | null;
	r2_key: string;
	see_also: string | null;
	prev_section_id: string | null;
	next_section_id: string | null;
	prev_section_label: string | null;
	next_section_label: string | null;
	sort_order: number;
}

// R2 Content Types

export interface ContentBlock {
	type: string;
	label?: string;
	content: string;
}

export interface SectionContent {
	version: 1;
	section_id: string;
	blocks: ContentBlock[];
}

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
