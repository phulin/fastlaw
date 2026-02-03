import type { Context } from "hono";
import { Hono } from "hono";
import { createD1DatabaseClient } from "./lib/bindings";
import { computeDiff } from "./lib/versioning";
import type { IngestJob, WorkerEnv } from "./types";

type AppContext = {
	Bindings: WorkerEnv;
};

const app = new Hono<AppContext>();

// Health check
app.get("/", (c) => {
	return c.json({ status: "ok", service: "fastlaw-ingest" });
});

// List source versions
app.get("/api/versions", async (c) => {
	const { results } = await c.env.DB.prepare(`
		SELECT sv.*, s.code as source_code, s.name as source_name
		FROM source_versions sv
		JOIN sources s ON sv.source_id = s.id
		ORDER BY sv.created_at DESC
		LIMIT 50
	`).all();
	return c.json({ versions: results });
});

// List R2 objects
app.get("/api/storage/objects", async (c) => {
	const prefix = c.req.query("prefix");
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const cursor = c.req.query("cursor");

	const result = await c.env.STORAGE.list({
		prefix,
		limit,
		cursor,
	});

	const cursorValue = "cursor" in result ? result.cursor : null;

	return c.json({
		objects: result.objects.map((obj) => ({
			key: obj.key,
			size: obj.size,
			etag: obj.etag,
			uploaded: obj.uploaded,
		})),
		truncated: result.truncated,
		cursor: cursorValue,
	});
});

// Get diff between two versions
app.get("/api/diff/:oldVersionId/:newVersionId", async (c) => {
	const oldVersionId = Number.parseInt(c.req.param("oldVersionId"), 10);
	const newVersionId = Number.parseInt(c.req.param("newVersionId"), 10);

	if (Number.isNaN(oldVersionId) || Number.isNaN(newVersionId)) {
		return c.json({ error: "Invalid version IDs" }, 400);
	}

	const diff = await computeDiff(
		createD1DatabaseClient(c.env.DB),
		oldVersionId,
		newVersionId,
	);
	return c.json({ diff });
});

// Trigger CGA ingestion
app.post("/api/ingest/cga", async (c) => {
	const job = await createIngestJob(c.env, "cga");
	await startContainerIngest(c, job.id, "cga");
	return c.json({ jobId: job.id });
});

// Trigger USC ingestion
app.post("/api/ingest/usc", async (c) => {
	const job = await createIngestJob(c.env, "usc");
	await startContainerIngest(c, job.id, "usc");
	return c.json({ jobId: job.id });
});

// Ingest job status
app.get("/api/ingest/jobs/:id", async (c) => {
	const jobId = c.req.param("id");
	const job = await c.env.DB.prepare("SELECT * FROM ingest_jobs WHERE id = ?")
		.bind(jobId)
		.first<IngestJob>();
	if (!job) {
		return c.json({ error: "Job not found" }, 404);
	}
	return c.json({ job });
});

// Progress events from container
app.post("/api/ingest/jobs/:id/progress", async (c) => {
	const jobId = c.req.param("id");
	const stub = c.env.PROGRESS_DO.get(c.env.PROGRESS_DO.idFromName(jobId));
	return await stub.fetch(c.req.raw);
});

// SSE events for job progress
app.get("/api/ingest/jobs/:id/events", async (c) => {
	const jobId = c.req.param("id");
	const stub = c.env.PROGRESS_DO.get(c.env.PROGRESS_DO.idFromName(jobId));
	return await stub.fetch(c.req.raw);
});

// Danger: delete all R2 objects and clear D1 tables
app.post("/api/admin/reset", async (c) => {
	let cursor: string | undefined;
	do {
		const listResult = await c.env.STORAGE.list({
			limit: 1000,
			cursor,
		});
		if (listResult.objects.length > 0) {
			await c.env.STORAGE.delete(listResult.objects.map((obj) => obj.key));
		}
		cursor = "cursor" in listResult ? listResult.cursor : undefined;
	} while (cursor);

	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM nodes"),
		c.env.DB.prepare("DELETE FROM blobs"),
		c.env.DB.prepare("DELETE FROM source_versions"),
		c.env.DB.prepare("DELETE FROM sources"),
		c.env.DB.prepare("DELETE FROM ingest_jobs"),
	]);

	return c.json({ status: "ok" });
});

async function createIngestJob(
	env: WorkerEnv,
	source: string,
): Promise<IngestJob> {
	const jobId = crypto.randomUUID();
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO ingest_jobs (
			id, source, status, progress, message, started_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(jobId, source, "queued", 0, "queued", null, now)
		.run();

	return {
		id: jobId,
		source,
		status: "queued",
		progress: 0,
		message: "queued",
		started_at: null,
		updated_at: now,
		finished_at: null,
		result_json: null,
		error_json: null,
	};
}

async function startContainerIngest(
	c: Context<AppContext>,
	jobId: string,
	source: "usc" | "cga",
): Promise<void> {
	const stub = c.env.INGEST_CONTAINER.get(
		c.env.INGEST_CONTAINER.idFromName(jobId),
	);
	const body = JSON.stringify({ jobId, source });
	const path = source === "usc" ? "/ingest/usc" : "/ingest/cga";
	const request = new Request(`http://container${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	c.executionCtx.waitUntil(stub.fetch(request));
}

export default app;
export { IngestContainer } from "./container";
export { ProgressDO } from "./progress-do";
