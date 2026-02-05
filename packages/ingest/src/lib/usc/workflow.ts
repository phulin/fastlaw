import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env, GenericWorkflowParams } from "../../types";
import { runGenericWorkflow } from "../workflows/generic";
import { uscAdapter } from "./adapter";
import type { USCWorkflowResult } from "./workflow-types";

export class USCIngestWorkflow extends WorkflowEntrypoint<
	Env,
	GenericWorkflowParams
> {
	async run(
		event: WorkflowEvent<GenericWorkflowParams>,
		step: WorkflowStep,
	): Promise<USCWorkflowResult> {
		return await runGenericWorkflow({
			env: this.env,
			step,
			payload: event.payload,
			adapter: uscAdapter,
		});
	}
}
