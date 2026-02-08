import { Hono } from "hono";
import { cgaAdapter } from "./lib/cga/adapter";
import { NodeStore } from "./lib/ingest/node-store";
import {
	completePlanning,
	createIngestJob,
	incrementProcessedShards,
	markPlanningFailed,
	recordShardError,
} from "./lib/ingest-jobs";
import { mglAdapter } from "./lib/mgl/adapter";
import { BlobStore } from "./lib/packfile";
import { uscAdapter } from "./lib/usc/adapter";
import { VectorIngestWorkflow } from "./lib/vector/workflow";
import {
	computeDiff,
	ensureSourceVersion,
	getOrCreateSource,
	insertNodesBatched,
} from "./lib/versioning";
import type {
	Env,
	IngestQueueMessage,
	IngestQueueShardWorkItem,
	IngestShardQueueMessage,
	IngestSourceCode,
	NodeMeta,
	VectorWorkflowParams,
} from "./types";

const SHARD_MESSAGE_ITEM_BATCH_SIZE = 200;
const QUEUE_SEND_BATCH_SIZE = 3;
const INGEST_QUEUE_MAX_RETRIES = 3;

type AppContext = {
	Bindings: Env;
};

type IngestRouteCode = "cga" | "mgl" | "usc";
type UnitWithId = { id: string };
type RootDiscovery = {
	versionId: string;
	rootNode: NodeMeta;
	unitRoots: UnitWithId[];
};
type PlannedUnit = {
	unitId: string;
	shardItems: IngestQueueShardWorkItem[];
};
type AdapterRegistration = {
	sourceCode: IngestSourceCode;
	adapter: {
		source: {
			code: string;
			name: string;
			jurisdiction: string;
			region: string;
			docType: string;
		};
		discoverRoot: (args: {
			env: Env;
			force: boolean;
		}) => Promise<RootDiscovery>;
		planUnit: (args: {
			env: Env;
			root: unknown;
			unit: unknown;
		}) => Promise<PlannedUnit>;
		loadShardItems: (args: {
			env: Env;
			root: unknown;
			unit: unknown;
			sourceId: string;
			sourceVersionId: string;
			items: IngestQueueShardWorkItem[];
			nodeStore: NodeStore;
			blobStore: BlobStore;
		}) => Promise<void>;
	};
};

const ADAPTERS_BY_ROUTE: Record<IngestRouteCode, AdapterRegistration> = {
	cga: {
		sourceCode: "cgs",
		adapter: cgaAdapter as unknown as AdapterRegistration["adapter"],
	},
	mgl: {
		sourceCode: "mgl",
		adapter: mglAdapter as unknown as AdapterRegistration["adapter"],
	},
	usc: {
		sourceCode: "usc",
		adapter: uscAdapter as unknown as AdapterRegistration["adapter"],
	},
};

const ADAPTERS_BY_SOURCE = new Map(
	Object.values(ADAPTERS_BY_ROUTE).map((entry) => [entry.sourceCode, entry]),
);

const app = new Hono<AppContext>();

async function readForceParam(c: {
	req: { json: <T>() => Promise<T> };
}): Promise<boolean | undefined> {
	const body = await c.req.json<{ force?: boolean }>().catch(() => ({}));
	return "force" in body ? body.force : undefined;
}

function normalizeUnitToken(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
	if (normalized.startsWith("title-") || normalized.startsWith("part-")) {
		return normalized;
	}
	return `title-${normalized}`;
}

function readUnitSelectors(unitsQuery: string | undefined): string[] {
	if (!unitsQuery) {
		return [];
	}
	return unitsQuery
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
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
		if (selectedIds.has(unit.id)) {
			continue;
		}
		selectedIds.add(unit.id);
		selected.push(unit);
	}

	return { selected, unknown };
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	return String(error);
}

async function sendShardMessages(
	env: Env,
	messages: MessageSendRequest<IngestShardQueueMessage>[],
): Promise<void> {
	for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE) {
		await env.INGEST_SHARDS_QUEUE.sendBatch(
			messages.slice(i, i + QUEUE_SEND_BATCH_SIZE),
		);
	}
}

async function startIngestJob(
	c: {
		env: Env;
		req: {
			query: (name: string) => string | undefined;
			json: <T>() => Promise<T>;
		};
		json: (body: unknown, status?: number) => Response;
	},
	routeCode: IngestRouteCode,
): Promise<Response> {
	const registration = ADAPTERS_BY_ROUTE[routeCode];
	const force = await readForceParam(c);
	const unitSelectors = readUnitSelectors(c.req.query("units"));

	const discovery = await registration.adapter.discoverRoot({
		env: c.env,
		force: force ?? false,
	});
	const { selected, unknown } = selectUnits(discovery.unitRoots, unitSelectors);
	if (unknown.length > 0) {
		return c.json({ error: "Unknown units", unknown }, 400);
	}

	const sourceId = await getOrCreateSource(
		c.env.DB,
		registration.adapter.source.code,
		registration.adapter.source.name,
		registration.adapter.source.jurisdiction,
		registration.adapter.source.region,
		registration.adapter.source.docType,
	);

	const sourceVersionId = `${registration.adapter.source.code}-${discovery.versionId}`;
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

	const jobId = await createIngestJob(c.env.DB, registration.sourceCode);
	let totalShards = 0;
	let totalQueueMessageBatches = 0;
	let totalQueueMessages = 0;
	let totalQueuedNodes = 0;

	try {
		const rootContext = {
			sourceId,
			sourceVersionId,
			rootNodeId: discovery.rootNode.id,
			versionId: discovery.versionId,
			rootNode: discovery.rootNode,
			unitRoots: discovery.unitRoots,
		};

		for (const unit of selected) {
			const plan = await registration.adapter.planUnit({
				env: c.env,
				root: rootContext,
				unit,
			});

			const queueMessages: MessageSendRequest<IngestShardQueueMessage>[] = [];
			for (
				let i = 0;
				i < plan.shardItems.length;
				i += SHARD_MESSAGE_ITEM_BATCH_SIZE
			) {
				queueMessages.push({
					body: {
						kind: "ingest-shard",
						jobId,
						sourceCode: registration.sourceCode,
						sourceId,
						sourceVersionId,
						unit,
						items: plan.shardItems.slice(i, i + SHARD_MESSAGE_ITEM_BATCH_SIZE),
					},
				});
			}

			await sendShardMessages(c.env, queueMessages);

			totalShards += plan.shardItems.length;
			totalQueuedNodes += plan.shardItems.length;
			totalQueueMessages += queueMessages.length;
			totalQueueMessageBatches += Math.ceil(
				queueMessages.length / QUEUE_SEND_BATCH_SIZE,
			);
		}

		console.log("Ingest queue enqueue summary", {
			jobId,
			sourceCode: registration.sourceCode,
			sourceVersionId,
			totalQueueMessageBatches,
			totalQueueMessages,
			totalQueuedNodes,
		});

		await completePlanning(c.env.DB, jobId, sourceVersionId, totalShards);

		return c.json({
			jobId,
			sourceCode: registration.sourceCode,
			sourceVersionId,
			totalUnits: selected.length,
			totalShards,
			status: totalShards === 0 ? "completed" : "running",
		});
	} catch (error) {
		const errorMessage = toErrorMessage(error);
		await markPlanningFailed(c.env.DB, jobId, errorMessage);
		console.error(`${routeCode.toUpperCase()} ingest planning failed:`, error);
		return c.json(
			{ error: `${routeCode.toUpperCase()} ingest planning failed` },
			500,
		);
	}
}

async function processIngestShardMessage(
	env: Env,
	body: IngestShardQueueMessage,
): Promise<void> {
	const registration = ADAPTERS_BY_SOURCE.get(body.sourceCode);
	if (!registration) {
		throw new Error(`Unsupported source code: ${body.sourceCode}`);
	}

	const blobStore = new BlobStore(
		env.DB,
		env.STORAGE,
		body.sourceId,
		body.sourceCode,
	);
	const nodeStore = new NodeStore(env.DB);

	await registration.adapter.loadShardItems({
		env,
		root: {
			versionId: body.sourceVersionId,
		},
		unit: body.unit as { id: string },
		sourceId: body.sourceId,
		sourceVersionId: body.sourceVersionId,
		items: body.items,
		nodeStore,
		blobStore,
	});

	await blobStore.flush();
	await nodeStore.flush();
	await incrementProcessedShards(env.DB, body.jobId, body.items.length);
}

// Health check
app.get("/", (c) => {
	return c.json({ status: "ok", service: "fastlaw-ingest" });
});

// List source versions
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

app.get("/api/ingest/jobs", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const { results } = await c.env.DB.prepare(
		`SELECT
			id,
			source_code,
			source_version_id,
			status,
			total_shards,
			processed_shards,
			error_count,
			last_error,
			started_at,
			completed_at,
			created_at,
			updated_at
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
		`SELECT
			id,
			source_code,
			source_version_id,
			status,
			total_shards,
			processed_shards,
			error_count,
			last_error,
			started_at,
			completed_at,
			created_at,
			updated_at
		FROM ingest_jobs
		WHERE id = ?`,
	)
		.bind(c.req.param("jobId"))
		.first();

	if (!job) {
		return c.json({ error: "Job not found" }, 404);
	}

	return c.json({ job });
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
	const oldVersionId = c.req.param("oldVersionId");
	const newVersionId = c.req.param("newVersionId");

	const diff = await computeDiff(c.env.DB, oldVersionId, newVersionId);
	return c.json({ diff });
});

app.post("/api/ingest/cga/jobs", async (c) => {
	try {
		return await startIngestJob(c, "cga");
	} catch (error) {
		console.error("CGA ingest start failed:", error);
		return c.json({ error: "CGA ingest start failed" }, 500);
	}
});

app.post("/api/ingest/mgl/jobs", async (c) => {
	try {
		return await startIngestJob(c, "mgl");
	} catch (error) {
		console.error("MGL ingest start failed:", error);
		return c.json({ error: "MGL ingest start failed" }, 500);
	}
});

app.post("/api/ingest/usc/jobs", async (c) => {
	try {
		return await startIngestJob(c, "usc");
	} catch (error) {
		console.error("USC ingest start failed:", error);
		return c.json({ error: "USC ingest start failed" }, 500);
	}
});

// Trigger vector ingestion via Cloudflare Workflow
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

		return c.json({
			instanceId: instance.id,
			status: await instance.status(),
		});
	} catch (error) {
		console.error("Vector workflow creation failed:", error);
		return c.json({ error: "Vector workflow creation failed" }, 500);
	}
});

// Get vector workflow status
app.get("/api/ingest/vector/workflow/:instanceId", async (c) => {
	try {
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.VECTOR_WORKFLOW.get(instanceId);

		return c.json({
			instanceId: instance.id,
			status: await instance.status(),
		});
	} catch (error) {
		console.error("Vector workflow status failed:", error);
		return c.json({ error: "Vector workflow status failed" }, 500);
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
		c.env.DB.prepare("DELETE FROM ingest_jobs"),
		c.env.DB.prepare("DELETE FROM nodes"),
		c.env.DB.prepare("DELETE FROM blobs"),
		c.env.DB.prepare("DELETE FROM source_versions"),
		c.env.DB.prepare("DELETE FROM sources"),
	]);

	return c.json({ status: "ok" });
});

const worker: ExportedHandler<Env, IngestQueueMessage> = {
	fetch: app.fetch,
	queue: async (batch, env) => {
		for (const message of batch.messages) {
			try {
				await processIngestShardMessage(env, message.body);
				message.ack();
			} catch (error) {
				const finalFailure = message.attempts >= INGEST_QUEUE_MAX_RETRIES;
				await recordShardError(
					env.DB,
					message.body.jobId,
					toErrorMessage(error),
					finalFailure,
				);
				if (finalFailure) {
					console.error(
						`Ingest shard permanently failed for job ${message.body.jobId}`,
						error,
					);
					message.ack();
				} else {
					message.retry();
				}
			}
		}
	},
};

export default worker;

// Export workflow class for Cloudflare
export { VectorIngestWorkflow };
