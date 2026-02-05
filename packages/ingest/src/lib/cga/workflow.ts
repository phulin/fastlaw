/**
 * CGA Cloudflare Workflow - generic ingestion pipeline adapter
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../../types";
import { runGenericWorkflow } from "../workflows/generic";
import { cgaAdapter } from "./adapter";
import type { CGAWorkflowParams, CGAWorkflowResult } from "./workflow-types";

export class CGAIngestWorkflow extends WorkflowEntrypoint<
	Env,
	CGAWorkflowParams
> {
	async run(
		event: WorkflowEvent<CGAWorkflowParams>,
		step: WorkflowStep,
	): Promise<CGAWorkflowResult> {
		return await runGenericWorkflow({
			env: this.env,
			step,
			payload: event.payload,
			adapter: cgaAdapter,
		});
	}
}
