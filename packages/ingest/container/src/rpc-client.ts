import type {
	BlobEntry,
	BlobLocation,
	DiffResult,
	NodeInsert,
	SourceVersion,
} from "./types";

/**
 * RPC client for calling back to the Durable Object from the container.
 * Makes HTTP requests to the Worker's /api/rpc/* endpoints.
 */
export class RpcClient {
	constructor(private baseUrl: string) {}

	private async call<T>(method: string, params: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}/api/rpc/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`RPC call ${method} failed: ${response.status} ${error}`);
		}

		const result = (await response.json()) as { result: T };
		return result.result;
	}

	async getOrCreateSource(
		code: string,
		name: string,
		jurisdiction: string,
		region: string,
		docType: string,
	): Promise<number> {
		return this.call("getOrCreateSource", {
			code,
			name,
			jurisdiction,
			region,
			docType,
		});
	}

	async getOrCreateSourceVersion(
		sourceId: number,
		versionDate: string,
	): Promise<number> {
		return this.call("getOrCreateSourceVersion", { sourceId, versionDate });
	}

	async getLatestVersion(sourceId: number): Promise<SourceVersion | null> {
		return this.call("getLatestVersion", { sourceId });
	}

	async loadBlobHashes(
		sourceId: number,
	): Promise<Record<string, BlobLocation>> {
		return this.call("loadBlobHashes", { sourceId });
	}

	async insertNodesBatched(nodes: NodeInsert[]): Promise<Map<string, number>> {
		const result = await this.call<Record<string, number>>(
			"insertNodesBatched",
			{ nodes },
		);
		return new Map(Object.entries(result));
	}

	async insertBlobs(
		sourceId: number,
		packfileKey: string,
		entries: BlobEntry[],
	): Promise<void> {
		return this.call("insertBlobs", { sourceId, packfileKey, entries });
	}

	async setRootNodeId(versionId: number, rootNodeId: number): Promise<void> {
		return this.call("setRootNodeId", { versionId, rootNodeId });
	}

	async computeDiff(
		oldVersionId: number,
		newVersionId: number,
	): Promise<DiffResult> {
		return this.call("computeDiff", { oldVersionId, newVersionId });
	}

	async insertNode(
		versionId: number,
		stringId: string,
		parentId: number | null,
		levelName: string,
		levelIndex: number,
		sortOrder: number,
		name: string | null,
		path: string | null,
		readableId: string | null,
		headingCitation: string | null,
		blobHash: string | null,
		sourceUrl: string | null,
		accessedAt: string | null,
	): Promise<number> {
		return this.call("insertNode", {
			versionId,
			stringId,
			parentId,
			levelName,
			levelIndex,
			sortOrder,
			name,
			path,
			readableId,
			headingCitation,
			blobHash,
			sourceUrl,
			accessedAt,
		});
	}
}
