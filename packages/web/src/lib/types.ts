// D1 Database Types - New unified schema

import type { TextItem } from "pdfjs-dist/types/src/display/api";

export interface SourceRecord {
	id: string;
	name: string;
	jurisdiction: string;
	region: string;
	doc_type: string;
}

export interface SourceVersionRecord {
	id: string;
	source_id: string;
	version_date: string;
	root_node_id: string | null;
	created_at: string | null;
}

export type IngestJobStatus =
	| "planning"
	| "running"
	| "completed"
	| "completed_with_errors"
	| "failed"
	| "aborted";

export interface IngestJobRecord {
	id: string;
	source_code: string;
	source_version_id: string | null;
	status: IngestJobStatus;
	total_titles: number;
	processed_titles: number;
	total_nodes: number;
	processed_nodes: number;
	error_count: number;
	last_error: string | null;
	started_at: string;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

export type IngestJobUnitStatus =
	| "pending"
	| "running"
	| "completed"
	| "skipped"
	| "error"
	| "aborted";

export interface IngestJobUnitRecord {
	id: number;
	job_id: string;
	unit_id: string;
	status: IngestJobUnitStatus;
	total_nodes: number;
	processed_nodes: number;
	error: string | null;
	started_at: string | null;
	completed_at: string | null;
}

export interface NodeRecord {
	id: string;
	source_version_id: string;
	readable_id: string | null;
	heading_citation: string | null;
	parent_id: string | null;
	level_name: string;
	level_index: number;
	sort_order: number;
	name: string | null;
	path: string | null;
	blob_hash: string | null; // xxhash64 stored as signed 64-bit int (string to avoid precision loss)
	source_url: string | null;
	accessed_at: string | null;
}

// Blob location from blobs table
export interface BlobRecord {
	hash: string;
	packfile_key: string;
	offset: number;
	size: number;
}

// Extended node with source info for convenience
export interface NodeWithSource extends NodeRecord {
	source_code: string;
	source_name: string;
}

export type PageData =
	| { status: "missing"; path: string }
	| {
			status: "found";
			path: string;
			statuteRoutePrefix: string;
			node: NodeRecord;
			source: SourceRecord;
			sourceVersion: SourceVersionRecord;
			ancestors: NodeRecord[];
			content?: NodeContent;
			nav?: { prev: NodeRecord | null; next: NodeRecord | null };
			children?: NodeRecord[];
			siblings?: NodeRecord[];
	  };

// R2 Content Types

export interface ContentBlock {
	type: string;
	label?: string;
	content?: string | null;
}

export interface SectionCrossReference {
	section: string;
	offset: number;
	length: number;
	link: string;
}

// Generic node content stored in R2 blobs
export interface NodeContent {
	blocks: ContentBlock[];
	metadata?: {
		cross_references?: SectionCrossReference[];
	};
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
/* ===========================
 * Public types
 * =========================== */

export interface Line {
	page: number;
	y: number; // baseline
	yStart: number; // top
	yEnd: number; // bottom
	xStart: number;
	xEnd: number;
	text: string;
	items: TextItem[];
	pageHeight: number;
	isBold: boolean;
}

export interface Paragraph {
	startPage: number;
	endPage: number;
	text: string;
	lines: Line[];
	confidence: number;
	y: number; // start line baseline
	yStart: number; // start line top
	yEnd: number; // start line bottom
	pageHeight: number;
	isBold: boolean;
	level?: number;
}

export class ParagraphRange {
	constructor(
		readonly paragraphs: Paragraph[],
		readonly startFirst: number,
		readonly endLast: number,
	) {
		this.paragraphs = paragraphs;
		this.startFirst = startFirst;
		this.endLast = endLast;
	}

	toText(): string {
		return this.paragraphs
			.map((paragraph, index) =>
				index === 0 && index === this.paragraphs.length - 1
					? paragraph.text.slice(this.startFirst, this.endLast)
					: index === 0
						? paragraph.text.slice(this.startFirst)
						: index === this.paragraphs.length - 1
							? paragraph.text.slice(0, this.endLast)
							: paragraph.text,
			)
			.join("\n");
	}
}
