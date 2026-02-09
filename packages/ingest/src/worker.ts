import { Hono } from "hono";
import {
	extractBearerToken,
	signCallbackToken,
	verifyCallbackToken,
} from "./lib/callback-auth";
import { IngestContainer } from "./lib/ingest-container";
import {
	completePlanning,
	createIngestJob,
	createJobUnits,
	incrementProcessedTitles,
	incrementUnitProcessedNodes,
	markUnitCompleted,
	markUnitRunning,
	recordTitleError,
} from "./lib/ingest-jobs";
import { hash64, hash64ToHex } from "./lib/packfile/hash";
import { PackfileDO } from "./lib/packfile-do";
import { uscAdapter } from "./lib/usc/adapter";
import { streamXmlFromZip } from "./lib/usc/fetcher";
import { VectorIngestWorkflow } from "./lib/vector/workflow";
import {
	computeDiff,
	ensureSourceVersion,
	getOrCreateSource,
	insertNodesBatched,
} from "./lib/versioning";
import type {
	Env,
	IngestNode,
	NodePayload,
	VectorWorkflowParams,
} from "./types";

type AppContext = {
	Bindings: Env;
};

const app = new Hono<AppContext>();

// ──────────────────────────────────────────────────────────────
// Health & admin
// ──────────────────────────────────────────────────────────────

app.get("/", (c) => {
	return c.json({ status: "ok", service: "fastlaw-ingest" });
});

app.get("/api/versions", async (c) => {
	const { results } = await c.env.DB.prepare(`
		SELECT sv.*, s.id as source_code, s.name as source_name
		FROM source_versions sv
		JOIN sources s ON sv.source_id = s.id
		ORDER BY sv.created_at DESC
		LIMIT 50
	`).all();
	return c.json({ versions: results });
});

const INGEST_JOB_COLUMNS = `
	id, source_code, source_version_id, status,
	total_titles, processed_titles, total_nodes, processed_nodes,
	error_count, last_error,
	started_at, completed_at, created_at, updated_at`;

app.get("/api/ingest/jobs", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const { results } = await c.env.DB.prepare(
		`SELECT ${INGEST_JOB_COLUMNS}
		FROM ingest_jobs
		ORDER BY created_at DESC
		LIMIT ?`,
	)
		.bind(limit)
		.all();
	return c.json({ jobs: results });
});

app.get("/api/ingest/jobs/:jobId", async (c) => {
	const job = await c.env.DB.prepare(
		`SELECT ${INGEST_JOB_COLUMNS}
		FROM ingest_jobs
		WHERE id = ?`,
	)
		.bind(c.req.param("jobId"))
		.first();

	if (!job) return c.json({ error: "Job not found" }, 404);
	return c.json({ job });
});

app.get("/api/ingest/jobs/:jobId/units", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT id, job_id, unit_id, status, total_nodes, processed_nodes,
			error, started_at, completed_at
		FROM ingest_job_units
		WHERE job_id = ?
		ORDER BY id`,
	)
		.bind(c.req.param("jobId"))
		.all();
	return c.json({ units: results });
});

app.get("/api/storage/objects", async (c) => {
	const prefix = c.req.query("prefix");
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const cursor = c.req.query("cursor");
	const result = await c.env.STORAGE.list({ prefix, limit, cursor });
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

app.get("/api/diff/:oldVersionId/:newVersionId", async (c) => {
	const diff = await computeDiff(
		c.env.DB,
		c.req.param("oldVersionId"),
		c.req.param("newVersionId"),
	);
	return c.json({ diff });
});

app.post("/api/admin/reset", async (c) => {
	let cursor: string | undefined;
	do {
		const listResult = await c.env.STORAGE.list({ limit: 1000, cursor });
		if (listResult.objects.length > 0) {
			await c.env.STORAGE.delete(listResult.objects.map((obj) => obj.key));
		}
		cursor = "cursor" in listResult ? listResult.cursor : undefined;
	} while (cursor);

	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM ingest_job_units"),
		c.env.DB.prepare("DELETE FROM ingest_jobs"),
		c.env.DB.prepare("DELETE FROM nodes"),
		c.env.DB.prepare("DELETE FROM blobs"),
		c.env.DB.prepare("DELETE FROM source_versions"),
		c.env.DB.prepare("DELETE FROM sources"),
	]);

	return c.json({ status: "ok" });
});

// ──────────────────────────────────────────────────────────────
// USC ingest via containers
// ──────────────────────────────────────────────────────────────

function normalizeUnitToken(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
	if (normalized.startsWith("title-") || normalized.startsWith("part-")) {
		return normalized;
	}
	return `title-${normalized}`;
}

function selectUnits<TUnit extends { id: string }>(
	units: TUnit[],
	selectors: string[],
): { selected: TUnit[]; unknown: string[] } {
	if (selectors.length === 0) {
		return { selected: units, unknown: [] };
	}

	const byId = new Map<string, TUnit>();
	for (const unit of units) {
		byId.set(unit.id.toLowerCase(), unit);
		byId.set(normalizeUnitToken(unit.id), unit);
	}

	const selected: TUnit[] = [];
	const selectedIds = new Set<string>();
	const unknown: string[] = [];

	for (const selector of selectors) {
		const normalizedSelector = normalizeUnitToken(selector);
		const unit =
			byId.get(selector.toLowerCase()) ?? byId.get(normalizedSelector);
		if (!unit) {
			unknown.push(selector);
			continue;
		}
		if (selectedIds.has(unit.id)) continue;
		selectedIds.add(unit.id);
		selected.push(unit);
	}

	return { selected, unknown };
}

app.post("/api/ingest/usc/jobs", async (c) => {
	try {
		const body = await c.req.json<{ force?: boolean }>().catch(() => ({}));
		const force = "force" in body ? body.force : false;
		const unitSelectors = (c.req.query("units") ?? "")
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v.length > 0);

		const discovery = await uscAdapter.discoverRoot({
			env: c.env,
			force: force ?? false,
		});
		const { selected, unknown } = selectUnits(
			discovery.unitRoots,
			unitSelectors,
		);
		if (unknown.length > 0) {
			return c.json({ error: "Unknown units", unknown }, 400);
		}

		const sourceId = await getOrCreateSource(
			c.env.DB,
			uscAdapter.source.code,
			uscAdapter.source.name,
			uscAdapter.source.jurisdiction,
			uscAdapter.source.region,
			uscAdapter.source.docType,
		);

		const sourceVersionId = `${uscAdapter.source.code}-${discovery.versionId}`;
		await ensureSourceVersion(
			c.env.DB,
			sourceId,
			discovery.versionId,
			discovery.rootNode.id,
		);

		await insertNodesBatched(c.env.DB, [
			{
				...discovery.rootNode,
				source_version_id: sourceVersionId,
				blob_hash: null,
			},
		]);

		const jobId = await createIngestJob(c.env.DB, "usc");
		await completePlanning(c.env.DB, jobId, sourceVersionId, selected.length);
		await createJobUnits(
			c.env.DB,
			jobId,
			selected.map((u) => u.id),
		);

		// In local dev, containers run in Docker and can't reach the host via
		// localhost. Replace with host.docker.internal so callbacks work.
		const origin = new URL(c.req.url).origin;
		const callbackBase = origin.replace(
			/localhost|127\.0\.0\.1/,
			"host.docker.internal",
		);
		const callbackToken = await signCallbackToken(
			{ jobId, sourceVersionId, sourceId },
			c.env.CALLBACK_SECRET,
		);

		const container = c.env.INGEST_CONTAINER.getByName(sourceVersionId);
		await container
			.fetch(
				new Request("http://container/ingest", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						units: selected.map((unit, i) => ({
							unit,
							titleSortOrder: i,
						})),
						callbackBase,
						callbackToken,
						sourceVersionId,
						rootNodeId: discovery.rootNode.id,
					}),
				}),
			)
			.then(async (res) => {
				if (!res.ok) {
					console.error(
						`Container returned ${res.status}: ${await res.text()}`,
					);
				}
			})
			.catch((err) => console.error("Container fetch failed:", err));

		return c.json({
			jobId,
			sourceCode: "usc",
			sourceVersionId,
			totalUnits: selected.length,
			status: selected.length === 0 ? "completed" : "running",
		});
	} catch (error) {
		console.error("USC ingest start failed:", error);
		return c.json({ error: "USC ingest start failed" }, 500);
	}
});

// ──────────────────────────────────────────────────────────────
// Container callbacks
// ──────────────────────────────────────────────────────────────

app.post("/api/callback/unitStart", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	const { unitId, totalNodes } = await c.req.json<{
		unitId: string;
		totalNodes: number;
	}>();

	await markUnitRunning(c.env.DB, params.jobId, unitId, totalNodes);
	console.log(
		`Unit ${unitId} started for job ${params.jobId}: ${totalNodes} nodes`,
	);
	return c.json({ ok: true });
});

app.post("/api/callback/insertNodeBatch", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	const { unitId, nodes } = await c.req.json<{
		unitId: string;
		nodes: NodePayload[];
	}>();

	const newBlobs: Array<{ hashHex: string; content: number[] }> = [];
	const nodeInserts: IngestNode[] = [];

	for (const node of nodes) {
		let blobHash: string | null = null;

		if (node.content) {
			const bytes = new TextEncoder().encode(JSON.stringify(node.content));
			blobHash = hash64ToHex(await hash64(bytes));

			const existing = await c.env.DB.prepare(
				"SELECT 1 FROM blobs WHERE source_id = ? AND hash = ?",
			)
				.bind(params.sourceId, blobHash)
				.first();

			if (!existing) {
				newBlobs.push({ hashHex: blobHash, content: Array.from(bytes) });
			}
		}

		nodeInserts.push({
			...node.meta,
			source_version_id: params.sourceVersionId,
			blob_hash: blobHash,
		});
	}

	if (newBlobs.length > 0) {
		const packfileDO = c.env.PACKFILE_DO.get(
			c.env.PACKFILE_DO.idFromName(params.sourceId),
		);
		await packfileDO.appendBlobs(params.sourceId, params.sourceId, newBlobs);
	}

	await insertNodesBatched(c.env.DB, nodeInserts);
	await incrementUnitProcessedNodes(
		c.env.DB,
		params.jobId,
		unitId,
		nodes.length,
	);
	return c.json({ accepted: nodes.length });
});

app.post("/api/callback/progress", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	const { unitId, status, error } = await c.req.json<{
		unitId: string;
		status: string;
		error?: string;
	}>();

	if (status === "completed" || status === "skipped") {
		await markUnitCompleted(
			c.env.DB,
			params.jobId,
			unitId,
			status as "completed" | "skipped",
		);
		await incrementProcessedTitles(c.env.DB, params.jobId, 1);
		console.log(`Title ${unitId} ${status} for job ${params.jobId}`);
	} else if (error) {
		await markUnitCompleted(c.env.DB, params.jobId, unitId, "error", error);
		await recordTitleError(c.env.DB, params.jobId, error, false);
		await incrementProcessedTitles(c.env.DB, params.jobId, 1);
		console.error(`Title ${unitId} failed for job ${params.jobId}: ${error}`);
	}

	return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// Generic R2 cache proxy
// ──────────────────────────────────────────────────────────────

const CACHE_R2_PREFIX = "cache/";

function getCacheKey(url: string, extractZip: boolean): string {
	const urlObj = new URL(url);
	const filename = urlObj.pathname.split("/").pop() ?? "unknown";
	if (extractZip && filename.toLowerCase().endsWith(".zip")) {
		return `${CACHE_R2_PREFIX}${filename.replace(/\.zip$/i, ".xml")}`;
	}
	return `${CACHE_R2_PREFIX}${filename}`;
}

app.post("/api/proxy/cache", async (c) => {
	try {
		const token = extractBearerToken(c.req.raw);
		await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	} catch {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const { url, extractZip } = await c.req.json<{
		url: string;
		extractZip?: boolean;
	}>();
	const r2Key = getCacheKey(url, extractZip ?? false);

	// Check if already cached
	const head = await c.env.STORAGE.head(r2Key);
	if (head) {
		return c.json({ r2Key, totalSize: head.size });
	}

	// Fetch the URL
	const response = await fetch(url, {
		headers: { "User-Agent": "fastlaw-ingest/1.0" },
	});
	if (!response.ok) {
		return c.json({ error: `Failed to fetch ${url}: ${response.status}` }, 502);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (extractZip && contentType.toLowerCase().includes("text/html")) {
		return c.json({ error: "html_response" }, 422);
	}

	let data: Uint8Array;
	if (extractZip && response.body) {
		// Extract XML from ZIP
		const chunks: Uint8Array[] = [];
		for await (const chunk of streamXmlFromZip(await response.arrayBuffer())) {
			chunks.push(chunk);
		}
		const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
		data = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}
	} else {
		data = new Uint8Array(await response.arrayBuffer());
	}

	// Cache in R2
	await c.env.STORAGE.put(r2Key, data);
	console.log(`Cached ${url} → ${r2Key} (${data.length} bytes)`);

	return c.json({ r2Key, totalSize: data.length });
});

app.get("/api/proxy/r2-read", async (c) => {
	try {
		const token = extractBearerToken(c.req.raw);
		await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	} catch {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const key = c.req.query("key");
	const offsetRaw = c.req.query("offset");
	const lengthRaw = c.req.query("length");

	if (!key) {
		return c.json({ error: "Missing key" }, 400);
	}

	const obj =
		lengthRaw == null
			? await c.env.STORAGE.get(key)
			: await c.env.STORAGE.get(key, {
					range: {
						offset: Number(offsetRaw ?? "0"),
						length: Number(lengthRaw),
					},
				});

	if (!obj) {
		return c.json({ error: `Object not found: ${key}` }, 404);
	}

	return new Response(obj.body, {
		headers: { "Content-Type": "application/octet-stream" },
	});
});

// ──────────────────────────────────────────────────────────────
// Vector workflow
// ──────────────────────────────────────────────────────────────

app.post("/api/ingest/vector/workflow", async (c) => {
	try {
		const body = await c.req
			.json<VectorWorkflowParams>()
			.catch(() => ({}) as VectorWorkflowParams);
		const instance = await c.env.VECTOR_WORKFLOW.create({
			params: {
				force: body.force,
				sourceId: body.sourceId,
				sourceVersionId: body.sourceVersionId,
				batchSize: body.batchSize,
			},
		});
		return c.json({ instanceId: instance.id, status: await instance.status() });
	} catch (error) {
		console.error("Vector workflow creation failed:", error);
		return c.json({ error: "Vector workflow creation failed" }, 500);
	}
});

app.get("/api/ingest/vector/workflow/:instanceId", async (c) => {
	try {
		const instance = await c.env.VECTOR_WORKFLOW.get(c.req.param("instanceId"));
		return c.json({ instanceId: instance.id, status: await instance.status() });
	} catch (error) {
		console.error("Vector workflow status failed:", error);
		return c.json({ error: "Vector workflow status failed" }, 500);
	}
});

// ──────────────────────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────────────────────

const worker: ExportedHandler<Env> = {
	fetch: app.fetch,
	queue() {},
};

export default worker;
export { IngestContainer, PackfileDO, VectorIngestWorkflow };
