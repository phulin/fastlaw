import type { WorkflowStep } from "cloudflare:workers";
import type { Env, GenericWorkflowParams } from "../../../types";
import { BlobStore } from "../../packfile";
import {
	ensureSourceVersion,
	getOrCreateSource,
	insertNodesBatched,
} from "../../versioning";
import { NodeStore } from "./node-store";
import { promiseAllWithConcurrency } from "./promise-all-with-concurrency";
import type {
	GenericWorkflowAdapter,
	GenericWorkflowResult,
	RootContext,
} from "./types";

const SHARD_BATCH_SIZE = 100;

function safeStepId(raw: string): string {
	return raw.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);
}

function unitIdFromRoot<TUnit extends Rpc.Serializable<TUnit>>(
	unit: TUnit,
): string {
	if (
		"id" in (unit as { id?: unknown }) &&
		typeof (unit as { id?: unknown }).id === "string"
	) {
		return (unit as { id: string }).id;
	}
	throw new Error("Unit root is missing string id");
}

export async function runGenericWorkflow<
	TUnit extends Rpc.Serializable<TUnit>,
	TShardMeta extends Rpc.Serializable<TShardMeta>,
>(args: {
	env: Env;
	step: WorkflowStep;
	payload: GenericWorkflowParams;
	adapter: GenericWorkflowAdapter<TUnit, TShardMeta>;
}): Promise<GenericWorkflowResult> {
	const { env, step, payload, adapter } = args;
	const force = payload.force ?? false;

	const root = await step.do("root", async () => {
		const discovery = await adapter.discoverRoot({ env, force });
		const sourceId = await getOrCreateSource(
			env.DB,
			adapter.source.code,
			adapter.source.name,
			adapter.source.jurisdiction,
			adapter.source.region,
			adapter.source.docType,
		);

		const canonicalName = `${adapter.source.code}-${discovery.versionId}`;
		const rootNodeId = discovery.rootNode.id;

		await ensureSourceVersion(
			env.DB,
			sourceId,
			discovery.versionId,
			rootNodeId,
		);

		const rootNode = {
			...discovery.rootNode,
			source_version_id: canonicalName,
			blob_hash: null,
		};

		await insertNodesBatched(env.DB, [rootNode]);

		const rootContext: RootContext<TUnit> = {
			sourceId,
			sourceVersionId: canonicalName,
			canonicalName,
			rootNodeId,
			versionId: discovery.versionId,
			rootNode,
			unitRoots: discovery.unitRoots,
		};

		return rootContext;
	});

	const unitsToProcess = payload.unitId
		? root.unitRoots.filter((unit) => unitIdFromRoot(unit) === payload.unitId)
		: root.unitRoots;

	if (payload.unitId && unitsToProcess.length === 0) {
		throw new Error(`Unknown unit id: ${payload.unitId}`);
	}

	if (unitsToProcess.length === 0) {
		return {
			sourceVersionId: root.sourceVersionId,
			canonicalName: root.canonicalName,
			unitsProcessed: 0,
			shardsProcessed: 0,
			nodesInserted: 0,
		};
	}

	const maxUnitConcurrency = Math.min(
		adapter.maxUnitConcurrency ?? unitsToProcess.length,
		unitsToProcess.length,
	);

	const unitResults = await promiseAllWithConcurrency(
		unitsToProcess.map((unit) => async () => {
			const unitKey = safeStepId(unitIdFromRoot(unit));
			// Keep unit plan out of step output storage to avoid the 1MiB limit
			// when large units produce many shard items.
			const plan = await adapter.planUnit({ env, root, unit });

			let shardsProcessed = 0;
			let nodesInserted = 0;
			for (let i = 0; i < plan.shardItems.length; i += SHARD_BATCH_SIZE) {
				const batch = plan.shardItems.slice(i, i + SHARD_BATCH_SIZE);
				const batchIndex = Math.floor(i / SHARD_BATCH_SIZE);
				const batchResult = await step.do(
					`unit-${unitKey}-shards-${batchIndex}`,
					async () => {
						const blobStore = new BlobStore(
							env.DB,
							env.STORAGE,
							root.sourceId,
							adapter.source.code,
						);
						const nodeStore = new NodeStore(env.DB);

						await adapter.loadShardItems({
							env,
							root,
							unit,
							sourceId: root.sourceId,
							sourceVersionId: root.sourceVersionId,
							items: batch,
							nodeStore,
							blobStore,
						});

						await blobStore.flush();
						const insertedCount = await nodeStore.flush();

						return { insertedCount };
					},
				);

				shardsProcessed += batch.length;
				nodesInserted += batchResult.insertedCount;
			}

			return { shardsProcessed, nodesInserted };
		}),
		maxUnitConcurrency,
	);

	const totalShardsProcessed = unitResults.reduce(
		(sum, result) => sum + result.shardsProcessed,
		0,
	);
	const totalNodesInserted = unitResults.reduce(
		(sum, result) => sum + result.nodesInserted,
		0,
	);

	return {
		sourceVersionId: root.sourceVersionId,
		canonicalName: root.canonicalName,
		unitsProcessed: unitsToProcess.length,
		shardsProcessed: totalShardsProcessed,
		nodesInserted: totalNodesInserted,
	};
}
