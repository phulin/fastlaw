import type { RpcClient } from "./rpc-client";
import type { BlobLocation } from "./types";

/**
 * Database backend that uses RPC calls to the Durable Object.
 * Used by BlobStore when running inside the container.
 */
export class RpcDbBackend {
	constructor(private rpc: RpcClient) {}

	async loadBlobHashes(sourceId: number): Promise<Map<string, BlobLocation>> {
		const hashes = await this.rpc.loadBlobHashes(sourceId);
		return new Map(Object.entries(hashes));
	}

	async insertBlobs(
		sourceId: number,
		packfileKey: string,
		entries: { hash: string; offset: number; size: number }[],
	): Promise<void> {
		await this.rpc.insertBlobs(sourceId, packfileKey, entries);
	}
}
