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
import { VectorIngestWorkflow } from "./lib/vector/workflow";
import {
	computeDiff,
	ensureSourceVersion,
	getOrCreateSource,
	insertNodes,
} from "./lib/versioning";
import { streamXmlFromZipStream } from "./lib/zip-utils";
import type {
	Env,
	IngestNode,
	NodeMeta,
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

const ABORTABLE_JOB_STATUSES = new Set(["planning", "running"]);
const TERMINAL_JOB_STATUSES = new Set([
	"completed",
	"completed_with_errors",
	"failed",
	"aborted",
]);

async function isJobAborted(db: D1Database, jobId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT status FROM ingest_jobs WHERE id = ?")
		.bind(jobId)
		.first<{ status: string }>();
	return row?.status === "aborted";
}

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

app.post("/api/ingest/jobs/:jobId/abort", async (c) => {
	const jobId = c.req.param("jobId");
	const job = await c.env.DB.prepare(
		`SELECT ${INGEST_JOB_COLUMNS}
		FROM ingest_jobs
		WHERE id = ?`,
	)
		.bind(jobId)
		.first<{ status: string }>();

	if (!job) {
		return c.json({ error: "Job not found" }, 404);
	}
	if (TERMINAL_JOB_STATUSES.has(job.status)) {
		return c.json(
			{ error: `Job cannot be aborted from status '${job.status}'` },
			409,
		);
	}
	if (!ABORTABLE_JOB_STATUSES.has(job.status)) {
		return c.json(
			{ error: `Job status '${job.status}' is not abortable` },
			409,
		);
	}

	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE ingest_jobs
				SET status = 'aborted', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND status IN ('planning', 'running')`,
		).bind(jobId),
		c.env.DB.prepare(
			`UPDATE ingest_job_units
				SET
					status = 'aborted',
					error = COALESCE(error, 'aborted by user'),
					completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
				WHERE job_id = ? AND status IN ('pending', 'running')`,
		).bind(jobId),
	]);

	const updatedJob = await c.env.DB.prepare(
		`SELECT ${INGEST_JOB_COLUMNS}
		FROM ingest_jobs
		WHERE id = ?`,
	)
		.bind(jobId)
		.first();

	return c.json({ ok: true, job: updatedJob });
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

app.post("/api/ingest/usc", async (c) => {
	try {
		const unitSelectors = (c.req.query("units") ?? "")
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v.length > 0);

		const sourceId = await getOrCreateSource(
			c.env.DB,
			"usc",
			"United States Code",
			"federal",
			"US",
			"statute",
		);

		const jobId = await createIngestJob(c.env.DB, "usc");

		// In local dev, containers run in Docker and can't reach the host via
		// localhost. Replace with host.docker.internal so callbacks work.
		const origin = new URL(c.req.url).origin;
		const callbackBase = origin.replace(
			/localhost|127\.0\.0\.1/,
			"host.docker.internal",
		);
		// sourceVersionId is unknown at this point, so we omit/leave empty in token
		const callbackToken = await signCallbackToken(
			{ jobId, sourceId },
			c.env.CALLBACK_SECRET,
		);

		const container = c.env.INGEST_CONTAINER.getByName("ingest");
		// Using "ingest" as a stable name for the service
		// We pass selectors but NO units. The container will discover.
		await container.registerJob(jobId);
		await container
			.fetch(
				new Request("http://container/ingest", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						source: "usc",
						sourceId,
						selectors: unitSelectors.length > 0 ? unitSelectors : undefined,
						callbackBase,
						callbackToken,
					}),
				}),
			)
			.then(async (res) => {
				if (!res.ok) {
					console.error(
						`Container returned ${res.status}: ${await res.text()}`,
					);
					await container.requestStopForJob(jobId);
				}
			})
			.catch(async (err) => {
				console.error("Container fetch failed:", err);
				await container.requestStopForJob(jobId);
			});

		return c.json({
			jobId,
			sourceCode: "usc",
			status: "planning", // Container is planning/discovering
		});
	} catch (error) {
		console.error("USC ingest start failed:", error);
		return c.json({ error: "USC ingest start failed" }, 500);
	}
});

app.post("/api/callback/ensureSourceVersion", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	if (await isJobAborted(c.env.DB, params.jobId)) {
		return c.json({ error: "Job aborted" }, 409);
	}
	const { sourceId, sourceVersionId, rootNode, units } = await c.req.json<{
		sourceId: string;
		sourceVersionId: string;
		rootNode: NodeMeta;
		units: Array<{ id: string; title_num: string; url: string }>;
	}>();

	console.log(
		`[Worker] ensureSourceVersion callback. jobId=${params.jobId}, svid=${sourceVersionId}, units=${units.length}`,
	);

	// ensureSourceVersion takes (db, sourceId, versionDate, rootNodeId).
	// Rust sends `usc-{version_id}`, so we extract the version suffix.
	const versionDate = sourceVersionId.replace(`${sourceId}-`, "");

	try {
		await ensureSourceVersion(c.env.DB, sourceId, versionDate, rootNode.id);

		// Insert root node
		await insertNodes(c.env.DB, [
			{
				...rootNode,
				source_version_id: sourceVersionId,
				blob_hash: null,
			},
		]);

		// Create job units and complete planning
		await completePlanning(
			c.env.DB,
			params.jobId,
			sourceVersionId,
			units.length,
		);
		await createJobUnits(
			c.env.DB,
			params.jobId,
			units.map((u) => u.id),
		);
	} catch (err) {
		console.error(`[Worker] Failed in ensureSourceVersion: ${err}`);
		return c.json({ error: String(err) }, 500);
	}

	return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
app.post("/api/callback/containerLog", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	const payload = await c.req.json<{
		level?: "debug" | "info" | "warn" | "error";
		message: string;
		context?: Record<string, unknown>;
	}>();
	const level = payload.level ?? "info";
	const context = payload.context ? ` ${JSON.stringify(payload.context)}` : "";
	const line = `[Container][${level}][job=${params.jobId}] ${payload.message}${context}`;

	if (level === "error") {
		console.error(line);
	} else if (level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}

	return c.json({ ok: true });
});

app.post("/api/callback/containerStop", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	const body = await c.req
		.json<{ reason?: string }>()
		.catch((): { reason?: string } => ({}));
	const reason = body.reason ?? "unspecified";

	console.log(
		`[Worker] containerStop callback received. jobId=${params.jobId}, reason=${reason}`,
	);

	const container = c.env.INGEST_CONTAINER.getByName("ingest");
	const result = await container.requestStopForJob(params.jobId);
	console.log(
		`[Worker] containerStop callback processed. jobId=${params.jobId}, stopped=${result.stopped}, remainingJobs=${result.runningJobs.length}`,
	);

	return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
app.post("/api/callback/unitStart", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	if (await isJobAborted(c.env.DB, params.jobId)) {
		return c.json({ error: "Job aborted" }, 409);
	}
	const { unitId, totalNodes } = await c.req.json<{
		unitId: string;
		totalNodes: number;
	}>();

	console.log(
		`[Worker] Unit ${unitId} start callback received. jobId=${params.jobId}, totalNodes=${totalNodes}`,
	);
	await markUnitRunning(c.env.DB, params.jobId, unitId, totalNodes);
	console.log(
		`Unit ${unitId} started for job ${params.jobId}: ${totalNodes} nodes`,
	);
	return c.json({ ok: true });
});

app.post("/api/callback/insertNodeBatch", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	if (await isJobAborted(c.env.DB, params.jobId)) {
		return c.json({ error: "Job aborted" }, 409);
	}
	const { unitId, nodes } = await c.req.json<{
		unitId: string;
		nodes: NodePayload[];
	}>();

	console.log(
		`[Worker] insertNodeBatch callback received. unitId=${unitId}, count=${nodes.length}`,
	);
	if (nodes.length > 0) {
		console.log(`[Worker] Sample node ID: ${nodes[0].meta.id}`);
	}
	const allBlobs: Array<{ hashHex: string; content: string }> = [];
	const nodeInserts: IngestNode[] = [];

	for (const node of nodes) {
		let blobHash: string | null = null;

		if (node.content) {
			const contentStr = JSON.stringify(node.content);
			const bytes = new TextEncoder().encode(contentStr);
			blobHash = hash64ToHex(await hash64(bytes));
			allBlobs.push({ hashHex: blobHash, content: contentStr });
		}

		nodeInserts.push({
			...node.meta,
			source_version_id:
				node.meta.source_version_id || params.sourceVersionId || "",
			blob_hash: blobHash,
		});
	}

	await insertNodes(c.env.DB, nodeInserts);
	await incrementUnitProcessedNodes(
		c.env.DB,
		params.jobId,
		unitId,
		nodes.length,
	);

	if (allBlobs.length > 0) {
		const packfileDO = c.env.PACKFILE_DO.get(
			c.env.PACKFILE_DO.idFromName(params.sourceId),
		);
		c.executionCtx.waitUntil(
			packfileDO.appendBlobs(params.sourceId, params.sourceId, allBlobs),
		);
	}

	return c.json({ accepted: nodes.length });
});

app.post("/api/callback/progress", async (c) => {
	const token = extractBearerToken(c.req.raw);
	const params = await verifyCallbackToken(token, c.env.CALLBACK_SECRET);
	if (await isJobAborted(c.env.DB, params.jobId)) {
		return c.json({ error: "Job aborted" }, 409);
	}
	const { unitId, status, error } = await c.req.json<{
		unitId: string;
		status: string;
		error?: string;
	}>();

	if (status === "completed" || status === "skipped") {
		await markUnitCompleted(c.env.DB, params.jobId, unitId, status);
		await incrementProcessedTitles(c.env.DB, params.jobId, 1);
		console.log(`Title ${unitId} ${status} for job ${params.jobId}`);
	} else if (error) {
		await markUnitCompleted(c.env.DB, params.jobId, unitId, "error", error);
		await recordTitleError(c.env.DB, params.jobId, error, false);
		await incrementProcessedTitles(c.env.DB, params.jobId, 1);
		console.error(`Title ${unitId} failed for job ${params.jobId}: ${error}`);
	}

	if (status === "completed" || status === "skipped" || error) {
		const packfileDO = c.env.PACKFILE_DO.get(
			c.env.PACKFILE_DO.idFromName(params.sourceId),
		);
		c.executionCtx.waitUntil(
			packfileDO.flush(params.sourceId, params.sourceId),
		);
	}

	return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// Generic R2 cache proxy
// ──────────────────────────────────────────────────────────────

const CACHE_R2_PREFIX = "cache/";
const R2_MULTIPART_PART_SIZE = 8 * 1024 * 1024;

function getCacheKey(url: string, extractZip: boolean): string {
	const urlObj = new URL(url);
	const filename = urlObj.pathname.split("/").pop() ?? "unknown";
	if (extractZip && filename.toLowerCase().endsWith(".zip")) {
		return `${CACHE_R2_PREFIX}${filename.replace(/\.zip$/i, ".xml")}`;
	}
	return `${CACHE_R2_PREFIX}${filename}`;
}

function concatChunks(chunks: Uint8Array[], totalSize: number): Uint8Array {
	const combined = new Uint8Array(totalSize);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return combined;
}

async function uploadMultipartFromChunks(
	bucket: R2Bucket,
	key: string,
	chunks: AsyncGenerator<Uint8Array, void, void>,
): Promise<number> {
	const upload = await bucket.createMultipartUpload(key);
	type UploadedPart = Awaited<ReturnType<R2MultipartUpload["uploadPart"]>>;
	const uploadedParts: UploadedPart[] = [];
	let partNumber = 1;
	let totalSize = 0;
	let pendingChunks: Uint8Array[] = [];
	let pendingSize = 0;

	const flushPart = async (force: boolean): Promise<void> => {
		if (pendingSize === 0) return;
		if (!force && pendingSize < R2_MULTIPART_PART_SIZE) return;
		const partData = concatChunks(pendingChunks, pendingSize);
		const uploadedPart = await upload.uploadPart(partNumber, partData);
		uploadedParts.push(uploadedPart);
		partNumber += 1;
		totalSize += partData.byteLength;
		pendingChunks = [];
		pendingSize = 0;
	};

	try {
		for await (const chunk of chunks) {
			pendingChunks.push(chunk);
			pendingSize += chunk.byteLength;
			await flushPart(false);
		}
		await flushPart(true);
		if (uploadedParts.length === 0) {
			await bucket.put(key, new Uint8Array(0));
			return 0;
		}
		await upload.complete(uploadedParts);
		return totalSize;
	} catch (error) {
		await upload.abort();
		throw error;
	}
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
	const responseBody = response.body;
	if (!responseBody) {
		return c.json({ error: "empty_response_body" }, 502);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (extractZip && contentType.toLowerCase().includes("text/html")) {
		return c.json({ error: "html_response" }, 422);
	}

	if (extractZip) {
		const totalSize = await uploadMultipartFromChunks(
			c.env.STORAGE,
			r2Key,
			streamXmlFromZipStream(responseBody as ReadableStream<Uint8Array>),
		);
		console.log(`Cached ${url} → ${r2Key} (${totalSize} bytes, multipart)`);
		return c.json({ r2Key, totalSize });
	}

	await c.env.STORAGE.put(r2Key, responseBody as ReadableStream);
	const stored = await c.env.STORAGE.head(r2Key);
	const totalSize = stored?.size ?? 0;
	console.log(`Cached ${url} → ${r2Key} (${totalSize} bytes)`);

	return c.json({ r2Key, totalSize });
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
