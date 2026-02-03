/// <reference types="node" />

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ingestCGA } from "./lib/cga/ingest";
import { createD1HttpClient } from "./lib/http/d1";
import { createS3ObjectStore } from "./lib/http/r2";
import { ingestUSC } from "./lib/usc/ingest";
import type { ContainerEnv, IngestContext } from "./types";

const app = new Hono();

app.get("/", (c) =>
	c.json({ status: "ok", service: "fastlaw-ingest-container" }),
);

app.post("/ingest/usc", async (c) => {
	const { jobId } = await c.req.json<{ jobId: string }>();
	await reportProgress(jobId, {
		status: "running",
		progress: 0,
		message: "starting USC ingest",
	});

	try {
		const env = getContainerEnv();
		const context = createIngestContext(env);
		const result = await ingestUSC(context);
		await reportProgress(jobId, {
			status: "succeeded",
			progress: 100,
			message: "USC ingest complete",
			result,
		});
		return c.json({ jobId, result });
	} catch (error) {
		await reportProgress(jobId, {
			status: "failed",
			progress: 100,
			message: "USC ingest failed",
			error,
		});
		throw error;
	}
});

app.post("/ingest/cga", async (c) => {
	const { jobId } = await c.req.json<{ jobId: string }>();
	await reportProgress(jobId, {
		status: "running",
		progress: 0,
		message: "starting CGA ingest",
	});

	try {
		const env = getContainerEnv();
		const context = createIngestContext(env);
		const result = await ingestCGA(context);
		await reportProgress(jobId, {
			status: "succeeded",
			progress: 100,
			message: "CGA ingest complete",
			result,
		});
		return c.json({ jobId, result });
	} catch (error) {
		await reportProgress(jobId, {
			status: "failed",
			progress: 100,
			message: "CGA ingest failed",
			error,
		});
		throw error;
	}
});

const port = Number(process.env.PORT ?? "8080");
serve({ fetch: app.fetch, port });

function getContainerEnv(): ContainerEnv {
	return {
		CGA_BASE_URL: process.env.CGA_BASE_URL ?? "",
		CGA_START_PATH: process.env.CGA_START_PATH ?? "",
		USC_DOWNLOAD_BASE: process.env.USC_DOWNLOAD_BASE ?? "",
		CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? "",
		D1_DATABASE_ID: process.env.D1_DATABASE_ID ?? "",
		D1_API_TOKEN: process.env.D1_API_TOKEN ?? "",
		R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "",
		R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "",
		R2_BUCKET_NAME: process.env.R2_BUCKET_NAME ?? "",
		INGEST_WORKER_URL: process.env.INGEST_WORKER_URL ?? "",
	};
}

function createIngestContext(env: ContainerEnv): IngestContext {
	return {
		db: createD1HttpClient(env),
		storage: createS3ObjectStore(env),
		CGA_BASE_URL: env.CGA_BASE_URL,
		CGA_START_PATH: env.CGA_START_PATH,
		USC_DOWNLOAD_BASE: env.USC_DOWNLOAD_BASE,
	};
}

async function reportProgress(
	jobId: string,
	update: {
		status: "queued" | "running" | "succeeded" | "failed";
		progress: number;
		message?: string;
		result?: unknown;
		error?: unknown;
	},
): Promise<void> {
	const base = (process.env.INGEST_WORKER_URL ?? "").replace(/\/$/, "");
	const url = `${base}/api/ingest/jobs/${jobId}/progress`;
	await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(update),
	});
}
