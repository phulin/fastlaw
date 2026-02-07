import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env, GenericWorkflowParams } from "../../types";
import { runGenericWorkflow } from "../workflows/generic";
import { mglAdapter } from "./adapter";
import type { MGLWorkflowResult } from "./workflow-types";

export class MGLIngestWorkflow extends WorkflowEntrypoint<
	Env,
	GenericWorkflowParams
> {
	async run(
		event: WorkflowEvent<GenericWorkflowParams>,
		step: WorkflowStep,
	): Promise<MGLWorkflowResult> {
		return await runGenericWorkflow({
			env: this.env,
			step,
			payload: event.payload,
			adapter: mglAdapter,
		});
	}
}
