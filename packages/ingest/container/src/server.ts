import { S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { RpcClient } from "./rpc-client";
import { RpcDbBackend } from "./rpc-db-backend";
import type { ContainerEnv, IngestionResult } from "./types";

// These will be dynamically imported from the shared lib
// The build process copies src/lib into the container
type IngestFn = (
	rpc: RpcClient,
	dbBackend: RpcDbBackend,
	s3Client: S3Client,
	bucketName: string,
	env: ContainerEnv,
) => Promise<IngestionResult>;

const app = new Hono();

function getEnv(): ContainerEnv {
	return {
		CGA_BASE_URL: process.env.CGA_BASE_URL ?? "https://www.cga.ct.gov",
		CGA_START_PATH: process.env.CGA_START_PATH ?? "/current/pub/titles.htm",
		USC_DOWNLOAD_BASE:
			process.env.USC_DOWNLOAD_BASE ??
			"https://uscode.house.gov/download/releasepoints",
		R2_S3_ACCOUNT_ID: process.env.R2_S3_ACCOUNT_ID ?? "",
		R2_S3_ACCESS_KEY_ID: process.env.R2_S3_ACCESS_KEY_ID ?? "",
		R2_S3_SECRET_ACCESS_KEY: process.env.R2_S3_SECRET_ACCESS_KEY ?? "",
		R2_S3_BUCKET_NAME: process.env.R2_S3_BUCKET_NAME ?? "fastlaw-content",
	};
}

function createS3Client(env: ContainerEnv): S3Client {
	return new S3Client({
		region: "auto",
		endpoint: `https://${env.R2_S3_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: env.R2_S3_ACCESS_KEY_ID,
			secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY,
		},
	});
}

// Health check
app.get("/", (c) => {
	return c.json({ status: "ok", service: "fastlaw-ingest-container" });
});

// SSE endpoint for streaming progress
app.get("/sse", (_c) => {
	// Simple SSE stream that sends heartbeats
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let count = 0;
			const interval = setInterval(() => {
				controller.enqueue(encoder.encode(`data: {"count":${count++}}\n\n`));
			}, 1000);

			// Clean up after 30 minutes
			setTimeout(
				() => {
					clearInterval(interval);
					controller.close();
				},
				30 * 60 * 1000,
			);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

// CGA ingestion endpoint
app.post("/ingest/cga", async (c) => {
	const body = (await c.req.json()) as { callbackUrl: string };
	const { callbackUrl } = body;

	if (!callbackUrl) {
		return c.json({ error: "callbackUrl is required" }, 400);
	}

	const env = getEnv();
	const rpc = new RpcClient(callbackUrl);
	const dbBackend = new RpcDbBackend(rpc);
	const s3Client = createS3Client(env);

	try {
		// Dynamically import the ingest function
		const { ingestCGAContainer } = (await import("./lib/cga/ingest")) as {
			ingestCGAContainer: IngestFn;
		};
		const result = await ingestCGAContainer(
			rpc,
			dbBackend,
			s3Client,
			env.R2_S3_BUCKET_NAME,
			env,
		);
		return c.json(result);
	} catch (error) {
		console.error("CGA ingest failed:", error);
		return c.json({ error: "CGA ingest failed", details: String(error) }, 500);
	}
});

// USC ingestion endpoint
app.post("/ingest/usc", async (c) => {
	const body = (await c.req.json()) as { callbackUrl: string };
	const { callbackUrl } = body;

	if (!callbackUrl) {
		return c.json({ error: "callbackUrl is required" }, 400);
	}

	const env = getEnv();
	const rpc = new RpcClient(callbackUrl);
	const dbBackend = new RpcDbBackend(rpc);
	const s3Client = createS3Client(env);

	try {
		// Dynamically import the ingest function
		const { ingestUSCContainer } = (await import("./lib/usc/ingest")) as {
			ingestUSCContainer: IngestFn;
		};
		const result = await ingestUSCContainer(
			rpc,
			dbBackend,
			s3Client,
			env.R2_S3_BUCKET_NAME,
			env,
		);
		return c.json(result);
	} catch (error) {
		console.error("USC ingest failed:", error);
		return c.json({ error: "USC ingest failed", details: String(error) }, 500);
	}
});

const port = Number(process.env.PORT) || 8080;
console.log(`Starting container server on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
