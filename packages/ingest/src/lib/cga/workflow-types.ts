/**
 * Type definitions for CGA Cloudflare Workflow
 */

export interface CGAWorkflowParams {
	/** Force re-ingestion even if version exists */
	force?: boolean;
}

export interface CGAWorkflowResult {
	sourceVersionId: string;
	canonicalName: string;
	unitsProcessed: number;
	shardsProcessed: number;
	nodesInserted: number;
}
