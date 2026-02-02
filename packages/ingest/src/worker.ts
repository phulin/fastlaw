import { Hono } from "hono";
import { ingestCGA } from "./lib/cga/ingest";
import { ingestUSC } from "./lib/usc/ingest";
import { computeDiff } from "./lib/versioning";
import type { Env } from "./types";

type AppContext = {
	Bindings: Env;
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

// Get diff between two versions
app.get("/api/diff/:oldVersionId/:newVersionId", async (c) => {
	const oldVersionId = Number.parseInt(c.req.param("oldVersionId"), 10);
	const newVersionId = Number.parseInt(c.req.param("newVersionId"), 10);

	if (Number.isNaN(oldVersionId) || Number.isNaN(newVersionId)) {
		return c.json({ error: "Invalid version IDs" }, 400);
	}

	const diff = await computeDiff(c.env.DB, oldVersionId, newVersionId);
	return c.json({ diff });
});

// Trigger CGA ingestion
app.post("/api/ingest/cga", async (c) => {
	const result = await ingestCGA(c.env);
	return c.json(result);
});

// Trigger USC ingestion
app.post("/api/ingest/usc", async (c) => {
	const result = await ingestUSC(c.env);
	return c.json(result);
});

export default app;
