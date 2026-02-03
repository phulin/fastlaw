import { Container } from "@cloudflare/containers";
import type { WorkerEnv } from "./types";

export class IngestContainer extends Container<WorkerEnv> {
	defaultPort = 8080;
	sleepAfter = "2m";
	envVars: Record<string, string>;

	// biome-ignore lint/complexity/noBannedTypes: Cloudflare container ctx expects DurableObjectState<{}>.
	constructor(ctx: DurableObjectState<{}>, env: WorkerEnv) {
		super(ctx, env);
		this.envVars = {
			CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
			D1_DATABASE_ID: env.D1_DATABASE_ID,
			D1_API_TOKEN: env.D1_API_TOKEN,
			R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
			R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
			R2_BUCKET_NAME: env.R2_BUCKET_NAME,
			INGEST_WORKER_URL: env.INGEST_WORKER_URL,
			CGA_BASE_URL: env.CGA_BASE_URL,
			CGA_START_PATH: env.CGA_START_PATH,
			USC_DOWNLOAD_BASE: env.USC_DOWNLOAD_BASE,
		};
	}
}
