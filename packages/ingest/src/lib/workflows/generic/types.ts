import type { Env, NodeInsert } from "../../../types";

export interface SourceDescriptor {
	code: string;
	name: string;
	jurisdiction: string;
	region: string;
	docType: string;
}

export interface NodePlan {
	stringId: string;
	parentStringId: string | null;
	levelName: string;
	levelIndex: number;
	sortOrder: number;
	name: string | null;
	path: string | null;
	readableId: string | null;
	headingCitation: string | null;
	sourceUrl: string | null;
	accessedAt: string | null;
}

export interface RootPlan<TUnit> {
	versionId: string;
	rootNode: NodePlan;
	unitRoots: TUnit[];
}

export interface RootContext<TUnit> extends RootPlan<TUnit> {
	sourceId: string;
	sourceVersionId: string;
	canonicalName: string;
	rootNodeId: string;
}

export interface UnitPlan<TShardInput> {
	unitId: string;
	structuralNodes: NodePlan[];
	shardInputs: TShardInput[];
}

export interface ShardPlan<TMeta> {
	key: string;
	meta: TMeta;
}

export interface ShardItem {
	node: NodePlan;
	content: unknown | null;
}

export interface GenericWorkflowAdapter<
	TUnit extends Rpc.Serializable<TUnit>,
	TShardInput extends Rpc.Serializable<TShardInput>,
	TShardMeta extends Rpc.Serializable<TShardMeta>,
> {
	source: SourceDescriptor;
	discoverRoot(args: { env: Env; force: boolean }): Promise<RootPlan<TUnit>>;
	planUnit(args: {
		env: Env;
		root: RootContext<TUnit>;
		unit: TUnit;
	}): Promise<UnitPlan<TShardInput>>;
	planShards(args: {
		env: Env;
		root: RootContext<TUnit>;
		unit: TUnit;
		unitPlan: UnitPlan<TShardInput>;
	}): Promise<Array<ShardPlan<TShardMeta>>>;
	loadShardItems(args: {
		env: Env;
		root: RootContext<TUnit>;
		shard: ShardPlan<TShardMeta>;
	}): Promise<ShardItem[]>;
}

export interface GenericWorkflowResult {
	sourceVersionId: string;
	canonicalName: string;
	unitsProcessed: number;
	shardsProcessed: number;
	nodesInserted: number;
}

export function toNodeInsert(
	versionId: string,
	node: NodePlan,
	parentId: string | null,
	blobHash: string | null,
): NodeInsert {
	return {
		id: node.stringId,
		source_version_id: versionId,
		parent_id: parentId,
		level_name: node.levelName,
		level_index: node.levelIndex,
		sort_order: node.sortOrder,
		name: node.name,
		path: node.path,
		readable_id: node.readableId,
		heading_citation: node.headingCitation,
		blob_hash: blobHash,
		source_url: node.sourceUrl,
		accessed_at: node.accessedAt,
	};
}
