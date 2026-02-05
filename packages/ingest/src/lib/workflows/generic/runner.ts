import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "../../../types";
import { BlobStore } from "../../packfile";
import {
	getOrCreateSource,
	getOrCreateSourceVersion,
	insertNode,
	insertNodesBatched,
	setRootNodeId,
} from "../../versioning";
import {
	type GenericWorkflowAdapter,
	type GenericWorkflowResult,
	type RootContext,
	toNodeInsert,
} from "./types";

const SHARD_BATCH_SIZE = 200;

function safeStepId(raw: string): string {
	return raw.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);
}

export async function runGenericWorkflow<
	TUnit extends Rpc.Serializable<TUnit>,
	TShardMeta extends Rpc.Serializable<TShardMeta>,
>(args: {
	env: Env;
	step: WorkflowStep;
	payload: { force?: boolean };
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
		const existingVersion = await env.DB.prepare(
			"SELECT id FROM source_versions WHERE id = ?",
		)
			.bind(canonicalName)
			.first<{ id: string }>();
		if (existingVersion && !force) {
			throw new Error(
				`Version ${canonicalName} already exists (id=${existingVersion.id}). Use force=true to re-ingest.`,
			);
		}

		const sourceVersionId = await getOrCreateSourceVersion(
			env.DB,
			sourceId,
			discovery.versionId,
		);

		const rootNodeId = await insertNode(
			env.DB,
			sourceVersionId,
			discovery.rootNode.stringId,
			null,
			discovery.rootNode.levelName,
			discovery.rootNode.levelIndex,
			discovery.rootNode.sortOrder,
			discovery.rootNode.name,
			discovery.rootNode.path,
			discovery.rootNode.readableId,
			discovery.rootNode.headingCitation,
			null,
			discovery.rootNode.sourceUrl,
			discovery.rootNode.accessedAt,
		);

		const rootContext: RootContext<TUnit> = {
			sourceId,
			sourceVersionId,
			canonicalName,
			rootNodeId,
			versionId: discovery.versionId,
			rootNode: discovery.rootNode,
			unitRoots: discovery.unitRoots,
		};

		return rootContext;
	});

	let totalShardsProcessed = 0;
	let totalNodesInserted = 0;

	for (const unit of root.unitRoots) {
		const unitKey = safeStepId(
			"id" in (unit as { id?: string })
				? String((unit as { id?: string }).id ?? "unit")
				: "unit",
		);
		const plan = await step.do(`unit-${unitKey}-plan`, async () => {
			return await adapter.planUnit({ env, root, unit });
		});

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

					const items = await adapter.loadShardItems({
						env,
						root,
						unit,
						items: batch,
					});

					const itemsWithContent = items.filter(
						(item) => item.content !== null,
					);
					const blobHashes = itemsWithContent.length
						? await blobStore.storeJsonBatch(
								itemsWithContent.map((item) => item.content),
							)
						: [];
					let blobIndex = 0;
					const nodes = items.map((item) => {
						const blobHash =
							item.content === null ? null : (blobHashes[blobIndex++] ?? null);
						const parentId = item.node.parentStringId;
						return toNodeInsert(
							root.sourceVersionId,
							item.node,
							parentId,
							blobHash,
						);
					});

					await blobStore.flush();
					await insertNodesBatched(env.DB, nodes);

					return { insertedCount: nodes.length };
				},
			);

			totalShardsProcessed += batch.length;
			totalNodesInserted += batchResult.insertedCount;
		}
	}

	await step.do("finalize", async () => {
		await setRootNodeId(env.DB, root.sourceVersionId, root.rootNodeId);
	});

	return {
		sourceVersionId: root.sourceVersionId,
		canonicalName: root.canonicalName,
		unitsProcessed: root.unitRoots.length,
		shardsProcessed: totalShardsProcessed,
		nodesInserted: totalNodesInserted,
	};
}
