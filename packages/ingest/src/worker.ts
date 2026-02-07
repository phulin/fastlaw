import { Hono } from "hono";
import { cgaAdapter } from "./lib/cga/adapter";
import { CGAIngestWorkflow } from "./lib/cga/workflow";
import { mglAdapter } from "./lib/mgl/adapter";
import { MGLIngestWorkflow } from "./lib/mgl/workflow";
import { uscAdapter } from "./lib/usc/adapter";
import { USCIngestWorkflow } from "./lib/usc/workflow";
import { VectorIngestWorkflow } from "./lib/vector/workflow";
import { computeDiff } from "./lib/versioning";
import type { Env, GenericWorkflowParams, VectorWorkflowParams } from "./types";

type AppContext = {
	Bindings: Env;
};

const app = new Hono<AppContext>();

async function readForceParam(c: {
	req: { json: <T>() => Promise<T> };
}): Promise<boolean | undefined> {
	const body = await c.req.json<{ force?: boolean }>().catch(() => ({}));
	return "force" in body ? body.force : undefined;
}

function normalizeUnitToken(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
	if (normalized.startsWith("title-")) {
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

async function createUnitWorkflowInstances<TUnit extends { id: string }>(
	workflow: Workflow<GenericWorkflowParams>,
	units: TUnit[],
	force: boolean | undefined,
): Promise<{
	totalUnits: number;
	instances: Array<{ unitId: string; instanceId: string }>;
}> {
	const instances = await Promise.all(
		units.map(async (unit) => {
			const instance = await workflow.create({
				params: { force, unitId: unit.id },
			});
			return {
				unitId: unit.id,
				instanceId: instance.id,
			};
		}),
	);

	return {
		totalUnits: instances.length,
		instances,
	};
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

// Trigger CGA ingestion via Cloudflare Workflow
app.post("/api/ingest/cga/workflow", async (c) => {
	try {
		const force = await readForceParam(c);
		const unitSelectors = readUnitSelectors(c.req.query("units"));

		const discovery = await cgaAdapter.discoverRoot({
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

		return c.json(
			await createUnitWorkflowInstances(c.env.CGA_WORKFLOW, selected, force),
		);
	} catch (error) {
		console.error("CGA workflow creation failed:", error);
		return c.json({ error: "CGA workflow creation failed" }, 500);
	}
});

// Get CGA workflow status
app.get("/api/ingest/cga/workflow/:instanceId", async (c) => {
	try {
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.CGA_WORKFLOW.get(instanceId);

		return c.json({
			instanceId: instance.id,
			status: await instance.status(),
		});
	} catch (error) {
		console.error("CGA workflow status failed:", error);
		return c.json({ error: "CGA workflow status failed" }, 500);
	}
});

// Trigger MGL ingestion via Cloudflare Workflow
app.post("/api/ingest/mgl/workflow", async (c) => {
	try {
		const force = await readForceParam(c);
		const unitSelectors = readUnitSelectors(c.req.query("units"));

		const discovery = await mglAdapter.discoverRoot({
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

		return c.json(
			await createUnitWorkflowInstances(c.env.MGL_WORKFLOW, selected, force),
		);
	} catch (error) {
		console.error("MGL workflow creation failed:", error);
		return c.json({ error: "MGL workflow creation failed" }, 500);
	}
});

// Get MGL workflow status
app.get("/api/ingest/mgl/workflow/:instanceId", async (c) => {
	try {
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.MGL_WORKFLOW.get(instanceId);

		return c.json({
			instanceId: instance.id,
			status: await instance.status(),
		});
	} catch (error) {
		console.error("MGL workflow status failed:", error);
		return c.json({ error: "MGL workflow status failed" }, 500);
	}
});

// Trigger USC ingestion via Cloudflare Workflow
app.post("/api/ingest/usc/workflow", async (c) => {
	try {
		const force = await readForceParam(c);
		const unitSelectors = readUnitSelectors(c.req.query("units"));

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

		return c.json(
			await createUnitWorkflowInstances(c.env.USC_WORKFLOW, selected, force),
		);
	} catch (error) {
		console.error("USC workflow creation failed:", error);
		return c.json({ error: "USC workflow creation failed" }, 500);
	}
});

// Get USC workflow status
app.get("/api/ingest/usc/workflow/:instanceId", async (c) => {
	try {
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.USC_WORKFLOW.get(instanceId);

		return c.json({
			instanceId: instance.id,
			status: await instance.status(),
		});
	} catch (error) {
		console.error("USC workflow status failed:", error);
		return c.json({ error: "USC workflow status failed" }, 500);
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
		c.env.DB.prepare("DELETE FROM nodes"),
		c.env.DB.prepare("DELETE FROM blobs"),
		c.env.DB.prepare("DELETE FROM source_versions"),
		c.env.DB.prepare("DELETE FROM sources"),
	]);

	return c.json({ status: "ok" });
});

export default app;

// Export workflow classes for Cloudflare
export {
	CGAIngestWorkflow,
	MGLIngestWorkflow,
	USCIngestWorkflow,
	VectorIngestWorkflow,
};
