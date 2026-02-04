import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
// Import from shared lib (copied during Docker build)
import { hash64, hash64ToHex } from "./lib/packfile/hash";
import { PackfileWriter } from "./lib/packfile/writer";
import type { RpcDbBackend } from "./rpc-db-backend";
import type { BlobLocation } from "./types";

/**
 * Container-specific BlobStore that uses S3 for storage and RPC for database.
 */
export class ContainerBlobStore {
	private dbBackend: RpcDbBackend;
	private s3Client: S3Client;
	private bucketName: string;
	private sourceId: number;
	private writer: PackfileWriter;
	private hashCache: Set<string> = new Set();
	private dbHashCache: Map<string, BlobLocation> | null = null;
	private dbHashCachePromise: Promise<Map<string, BlobLocation>> | null = null;

	constructor(
		dbBackend: RpcDbBackend,
		s3Client: S3Client,
		bucketName: string,
		sourceId: number,
		sourceCode: string,
	) {
		this.dbBackend = dbBackend;
		this.s3Client = s3Client;
		this.bucketName = bucketName;
		this.sourceId = sourceId;
		this.writer = new PackfileWriter(sourceCode);
	}

	private async withContext<T>(
		label: string,
		action: () => Promise<T>,
	): Promise<T> {
		try {
			return await action();
		} catch (error) {
			console.error(`[BlobStore] ${label} failed:`, error);
			throw error;
		}
	}

	private async loadDbHashes(): Promise<Map<string, BlobLocation>> {
		if (this.dbHashCache !== null) {
			return this.dbHashCache;
		}
		if (this.dbHashCachePromise) {
			return this.dbHashCachePromise;
		}

		this.dbHashCachePromise = (async () => {
			const cache = await this.withContext("db.loadHashes", () =>
				this.dbBackend.loadBlobHashes(this.sourceId),
			);

			this.dbHashCache = cache;
			this.dbHashCachePromise = null;

			console.log(`Loaded ${cache.size} existing blob hashes.`);

			return cache;
		})();

		return this.dbHashCachePromise;
	}

	private async blobExists(hashHex: string): Promise<boolean> {
		if (this.hashCache.has(hashHex)) {
			return true;
		}
		const cache = await this.loadDbHashes();
		return cache.has(hashHex);
	}

	async storeBlob(content: Uint8Array): Promise<string> {
		const hashValue = await hash64(content);
		const hashHex = hash64ToHex(hashValue);

		if (await this.blobExists(hashHex)) {
			return hashHex;
		}

		await this.writer.addBlob(content);
		await this.uploadFinishedPackfiles();

		this.hashCache.add(hashHex);

		return hashHex;
	}

	async storeJson(data: unknown): Promise<string> {
		const json = JSON.stringify(data);
		const bytes = new TextEncoder().encode(json);
		return this.storeBlob(bytes);
	}

	async flush(): Promise<void> {
		await this.writer.finalize();
		await this.uploadFinishedPackfiles();
	}

	private async uploadFinishedPackfiles(): Promise<void> {
		const packfiles = this.writer.drainFinishedPackfiles();
		if (packfiles.length === 0) {
			return;
		}

		for (const packfile of packfiles) {
			// Upload to S3
			await this.withContext(`s3.put(${packfile.key})`, async () => {
				await this.s3Client.send(
					new PutObjectCommand({
						Bucket: this.bucketName,
						Key: packfile.key,
						Body: packfile.data,
					}),
				);
			});
			console.log(
				`Uploaded packfile ${packfile.key} (${packfile.data.length} bytes, ${packfile.entries.length} blobs)`,
			);

			// Record blob locations via RPC
			const entries = packfile.entries.map((entry) => ({
				hash: hash64ToHex(entry.hash),
				offset: entry.offset,
				size: entry.size,
			}));
			await this.withContext(`db.insertBlobs(${packfile.key})`, () =>
				this.dbBackend.insertBlobs(this.sourceId, packfile.key, entries),
			);
			console.log(
				`Inserted ${entries.length} blob records for ${packfile.key}`,
			);
		}
	}

	async getBlobLocation(hashHex: string): Promise<BlobLocation | null> {
		const cache = await this.loadDbHashes();
		return cache.get(hashHex) || null;
	}
}
