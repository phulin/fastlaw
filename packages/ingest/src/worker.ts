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

	const diff = await computeDiff(c.env.DB, oldVersionId, newVersionId);
	return c.json({ diff });
});

// Trigger CGA ingestion
app.post("/api/ingest/cga", async (c) => {
	try {
		const result = await ingestCGA(c.env);
		return c.json(result);
	} catch (error) {
		console.error("CGA ingest failed:", error);
		return c.json({ error: "CGA ingest failed" }, 500);
	}
});

// Trigger USC ingestion
app.post("/api/ingest/usc", async (c) => {
	try {
		const result = await ingestUSC(c.env);
		return c.json(result);
	} catch (error) {
		console.error("USC ingest failed:", error);
		return c.json({ error: "USC ingest failed" }, 500);
	}
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
	]);

	return c.json({ status: "ok" });
});

export default app;
