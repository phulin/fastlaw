/**
 * Type definitions for CGA Cloudflare Workflow
 */

export interface CGAWorkflowParams {
	/** Force re-ingestion even if version exists */
	force?: boolean;
}

export interface RootStepOutput {
	sourceVersionId: number;
	versionId: string; // Year for R2 paths (e.g., "2025")
	canonicalName: string; // Full canonical name (e.g., "cgs-2025")
	rootNodeId: number;
	titleUrls: string[];
}

export interface TitleStepOutput {
	titleNodeId: number;
	titleId: string;
	chapterUrls: Array<{
		url: string;
		type: "chapter" | "article";
	}>;
}

/** A slice of sections from a single chapter, used within cross-chapter batches */
export interface SectionBatchItem {
	chapterNodeId: number;
	chapterId: string;
	chapterUrl: string;
	startIndex: number; // First section index (inclusive)
	endIndex: number; // Last section index (exclusive)
}

export interface ChapterBatchItem {
	url: string;
	type: "chapter" | "article";
}

export interface ChapterBatch {
	titleNodeId: number;
	titleId: string;
	chapters: ChapterBatchItem[];
}

export interface ChapterStepOutput {
	chapterNodeId: number;
	chapterId: string;
	chapterUrl: string; // For section steps to fetch from R2 cache
	totalSections: number;
}

export interface SectionBatchOutput {
	insertedCount: number;
}

export interface FinalizeOutput {
	sourceVersionId: number;
	canonicalName: string;
	titlesProcessed: number;
	chaptersProcessed: number;
	sectionsInserted: number;
}
