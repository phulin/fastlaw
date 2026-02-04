import type { D1Database } from "@cloudflare/workers-types";

import { insertNodesBatched, type NodeInsert } from "./versioning";

export class NodeBatcher {
	private nodes: NodeInsert[] = [];

	constructor(
		private db: D1Database,
		private batchSize: number,
		private onInserted?: (nodeIdMap: Map<string, number>) => void,
	) {}

	get size(): number {
		return this.nodes.length;
	}

	async add(node: NodeInsert): Promise<void> {
		this.nodes.push(node);
		if (this.nodes.length >= this.batchSize) {
			await this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.nodes.length === 0) return;
		const batch = this.nodes.splice(0, this.nodes.length);
		const nodeIdMap = await insertNodesBatched(this.db, batch);
		this.onInserted?.(nodeIdMap);
	}
}
