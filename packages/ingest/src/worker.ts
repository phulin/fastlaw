import { Container } from "@cloudflare/containers";
import { Hono } from "hono";
import { ingestCGA } from "./lib/cga/ingest";
import { ingestUSC } from "./lib/usc/ingest";
import {
	computeDiff as computeDiffImpl,
	getLatestVersion as getLatestVersionImpl,
	getOrCreateSource as getOrCreateSourceImpl,
	getOrCreateSourceVersion as getOrCreateSourceVersionImpl,
	insertNodesBatched as insertNodesBatchedImpl,
	setRootNodeId as setRootNodeIdImpl,
} from "./lib/versioning";
import type {
	BlobEntry,
	BlobLocation,
	DiffResult,
	Env,
	NodeInsert,
	SourceVersion,
} from "./types";

export class IngestRunner extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "30m";

	// RPC: Get or create a source
	async getOrCreateSource(
		code: string,
		name: string,
		jurisdiction: string,
		region: string,
		docType: string,
	): Promise<number> {
		return getOrCreateSourceImpl(
			this.env.DB,
			code,
			name,
			jurisdiction,
			region,
			docType,
		);
	}

	// RPC: Get or create a source version
	async getOrCreateSourceVersion(
		sourceId: number,
		versionDate: string,
	): Promise<number> {
		return getOrCreateSourceVersionImpl(this.env.DB, sourceId, versionDate);
	}

	// RPC: Get the latest version for a source
	async getLatestVersion(sourceId: number): Promise<SourceVersion | null> {
		return getLatestVersionImpl(this.env.DB, sourceId);
	}

	// RPC: Load all blob hashes for a source (for deduplication)
	async loadBlobHashes(
		sourceId: number,
	): Promise<Record<string, BlobLocation>> {
		const result = await this.env.DB.prepare(
			`SELECT hash, packfile_key, offset, size FROM blobs WHERE source_id = ?`,
		)
			.bind(sourceId)
			.all<{
				hash: string;
				packfile_key: string;
				offset: number;
				size: number;
			}>();

		const hashes: Record<string, BlobLocation> = {};
		for (const row of result.results) {
			hashes[row.hash] = {
				packfileKey: row.packfile_key,
				offset: row.offset,
				size: row.size,
			};
		}
		return hashes;
	}

	// RPC: Insert nodes in batches, returns map of stringId -> nodeId
	async insertNodesBatched(
		nodes: NodeInsert[],
	): Promise<Record<string, number>> {
		const resultMap = await insertNodesBatchedImpl(this.env.DB, nodes);
		// Convert Map to plain object for RPC serialization
		const result: Record<string, number> = {};
		for (const [key, value] of resultMap) {
			result[key] = value;
		}
		return result;
	}

	// RPC: Insert blob records for a packfile
	async insertBlobs(
		sourceId: number,
		packfileKey: string,
		entries: BlobEntry[],
	): Promise<void> {
		const BATCH_SIZE = 50;
		for (let i = 0; i < entries.length; i += BATCH_SIZE) {
			const batch = entries.slice(i, i + BATCH_SIZE);
			const statements = batch.map((entry) =>
				this.env.DB.prepare(
					`INSERT OR IGNORE INTO blobs (hash, source_id, packfile_key, offset, size)
					 VALUES (?, ?, ?, ?, ?)`,
				).bind(entry.hash, sourceId, packfileKey, entry.offset, entry.size),
			);
			await this.env.DB.batch(statements);
		}
	}

	// RPC: Set the root node ID for a version
	async setRootNodeId(versionId: number, rootNodeId: number): Promise<void> {
		return setRootNodeIdImpl(this.env.DB, versionId, rootNodeId);
	}

	// RPC: Compute diff between two versions
	async computeDiff(
		oldVersionId: number,
		newVersionId: number,
	): Promise<DiffResult> {
		return computeDiffImpl(this.env.DB, oldVersionId, newVersionId);
	}
}

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

	const diff = await computeDiffImpl(c.env.DB, oldVersionId, newVersionId);
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

// Stream SSE from container (re-emit to client)
app.get("/api/ingest/sse", async (c) => {
	const id = c.env.INGEST_RUNNER.idFromName("ingest");
	const stub = c.env.INGEST_RUNNER.get(id) as unknown as IngestRunner;
	await stub.startAndWaitForPorts(8080);
	const response = await stub.fetch(new Request("http://container/sse"));

	const body = response.body;
	if (!body) {
		return c.json({ error: "No response body from container" }, 500);
	}

	// Create a TransformStream to process and re-emit SSE events
	const { readable, writable } = new TransformStream<string, string>();
	const writer = writable.getWriter();

	// Process the container's SSE stream
	const processStream = async () => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE events from buffer
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("data:")) {
						const data = line.slice(5).trim();
						// Re-emit event to client
						await writer.write(`data: ${data}\n\n`);
					}
				}
			}
		} finally {
			await writer.close();
		}
	};

	// Start processing in the background
	processStream();

	return new Response(readable.pipeThrough(new TextEncoderStream()), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

// Stream SSE from container via WebSocket bridge
app.get("/api/ingest/ws-sse", async (c) => {
	const id = c.env.INGEST_RUNNER.idFromName("ingest");
	const stub = c.env.INGEST_RUNNER.get(id) as unknown as IngestRunner;
	await stub.startAndWaitForPorts(8080);

	// Connect to container via WebSocket
	const wsResponse = await stub.fetch(
		new Request("http://container/ws", {
			headers: { Upgrade: "websocket" },
		}),
	);

	const ws = wsResponse.webSocket;
	if (!ws) {
		return c.json({ error: "WebSocket upgrade failed" }, 500);
	}

	ws.accept();

	// Create a TransformStream to convert WebSocket messages to SSE
	const { readable, writable } = new TransformStream<string, string>();
	const writer = writable.getWriter();

	ws.addEventListener("message", async (event: MessageEvent) => {
		const data =
			typeof event.data === "string"
				? event.data
				: new TextDecoder().decode(event.data as ArrayBuffer);
		await writer.write(`data: ${data}\n\n`);
	});

	ws.addEventListener("close", async () => {
		await writer.close();
	});

	ws.addEventListener("error", async () => {
		await writer.abort();
	});

	return new Response(readable.pipeThrough(new TextEncoderStream()), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
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
