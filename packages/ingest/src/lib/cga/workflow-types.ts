/**
 * Type definitions for CGA Cloudflare Workflow
 */

export interface CGAWorkflowResult {
	sourceVersionId: string;
	canonicalName: string;
	unitsProcessed: number;
	shardsProcessed: number;
	nodesInserted: number;
}
