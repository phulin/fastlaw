import type { Env, NodeMeta } from "../../../types";
import type { BlobStore } from "../../packfile";
import type { NodeStore } from "./node-store";

export interface SourceDescriptor {
	code: string;
	name: string;
	jurisdiction: string;
	region: string;
	docType: string;
}

export interface RootPlan<TUnit> {
	versionId: string;
	rootNode: NodeMeta;
	unitRoots: TUnit[];
}

export interface RootContext<TUnit> extends RootPlan<TUnit> {
	sourceId: string;
	sourceVersionId: string;
	canonicalName: string;
	rootNodeId: string;
}

export interface ShardWorkItem<TMeta> {
	parentId: string;
	childId: string;
	sourceUrl: string;
	meta: TMeta;
}

export interface UnitPlan<TShardMeta> {
	unitId: string;
	shardItems: Array<ShardWorkItem<TShardMeta>>;
}

export interface GenericWorkflowAdapter<
	TUnit extends Rpc.Serializable<TUnit>,
	TShardMeta extends Rpc.Serializable<TShardMeta>,
> {
	source: SourceDescriptor;
	maxUnitConcurrency?: number;
	discoverRoot(args: { env: Env; force: boolean }): Promise<RootPlan<TUnit>>;
	planUnit(args: {
		env: Env;
		root: RootContext<TUnit>;
		unit: TUnit;
	}): Promise<UnitPlan<TShardMeta>>;
	loadShardItems(args: {
		env: Env;
		root: RootContext<TUnit>;
		unit: TUnit;
		sourceId: string;
		sourceVersionId: string;
		items: Array<ShardWorkItem<TShardMeta>>;
		nodeStore: NodeStore;
		blobStore: BlobStore;
	}): Promise<void>;
}

export interface GenericWorkflowResult {
	sourceVersionId: string;
	canonicalName: string;
	unitsProcessed: number;
	shardsProcessed: number;
	nodesInserted: number;
}
