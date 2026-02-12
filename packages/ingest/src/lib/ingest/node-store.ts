import type { NodeInsert, NodeMeta } from "../../types";
import { insertNodes } from "../versioning";

const NODE_BATCH_SIZE = 100;

function toNodeInsert(node: NodeMeta, blobHash: string | null): NodeInsert {
	return {
		...node,
		blob_hash: blobHash,
	};
}

export class NodeStore {
	private db: D1Database;
	private pending: NodeInsert[] = [];
	private insertedCount = 0;

	constructor(db: D1Database) {
		this.db = db;
	}

	async store(node: NodeMeta, blobHash: string | null): Promise<void> {
		this.pending.push(toNodeInsert(node, blobHash));
		if (this.pending.length >= NODE_BATCH_SIZE) {
			await this.flushPending();
		}
	}

	async flush(): Promise<number> {
		await this.flushPending();
		const count = this.insertedCount;
		this.insertedCount = 0;
		return count;
	}

	private async flushPending(): Promise<void> {
		if (this.pending.length === 0) {
			return;
		}

		const batch = this.pending;
		this.pending = [];
		await insertNodes(this.db, batch);
		this.insertedCount += batch.length;
	}
}
