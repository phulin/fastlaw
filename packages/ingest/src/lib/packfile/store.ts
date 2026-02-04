import { hash64, hash64ToHex, hexToHash64, verifyHashPrefix } from "./hash";
import { extractBlob, PackfileWriter } from "./writer";

export interface BlobLocation {
	packfileKey: string;
	offset: number;
	size: number;
}

const BATCH_SIZE = 50;

/**
 * BlobStore manages blob storage using packfiles.
 *
 * Usage:
 *   const store = new BlobStore(db, storage, sourceId, 'cgs');
 *   const hash = await store.storeBlob(jsonContent);
 *   // ... store more blobs ...
 *   await store.flush(); // Upload any pending packfiles
 */
export class BlobStore {
	private db: D1Database;
	private storage: R2Bucket;
	private sourceId: number;
	private writer: PackfileWriter;
	private hashCache: Set<string> = new Set(); // Track hashes we've seen this session (hex strings)
	private dbHashCache: Map<string, BlobLocation> | null = null; // Lazy-loaded from DB
	private dbHashCachePromise: Promise<Map<string, BlobLocation>> | null = null;

	constructor(
		db: D1Database,
		storage: R2Bucket,
		sourceId: number,
		sourceCode: string,
	) {
		this.db = db;
		this.storage = storage;
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

	/**
	 * Load existing blob hashes from the database for deduplication
	 */
	private async loadDbHashes(): Promise<Map<string, BlobLocation>> {
		if (this.dbHashCache !== null) {
			return this.dbHashCache;
		}
		if (this.dbHashCachePromise) {
			return this.dbHashCachePromise;
		}

		this.dbHashCachePromise = (async () => {
			const cache = new Map<string, BlobLocation>();

			// Load all existing blob hashes for this source
			const result = await this.withContext("db.loadHashes", () =>
				this.db
					.prepare(
						`SELECT hash, packfile_key, offset, size FROM blobs
						 WHERE source_id = ?`,
					)
					.bind(this.sourceId)
					.all<{
						hash: string;
						packfile_key: string;
						offset: number;
						size: number;
					}>(),
			);

			for (const row of result.results) {
				cache.set(row.hash, {
					packfileKey: row.packfile_key,
					offset: row.offset,
					size: row.size,
				});
			}

			this.dbHashCache = cache;
			this.dbHashCachePromise = null;

			console.log(`Loaded ${cache.size} existing blob hashes.`);

			return cache;
		})();

		return this.dbHashCachePromise;
	}

	/**
	 * Check if a blob with the given hash already exists
	 */
	private async blobExists(hashHex: string): Promise<boolean> {
		// Check session cache first
		if (this.hashCache.has(hashHex)) {
			return true;
		}

		// Check DB cache
		const cache = await this.loadDbHashes();
		return cache.has(hashHex);
	}

	/**
	 * Store a blob, returning its hash as a hex string.
	 * If the blob already exists (by hash), it won't be stored again.
	 */
	async storeBlob(content: Uint8Array): Promise<string> {
		const hash = await hash64(content);
		const hashHex = hash64ToHex(hash);

		// Check for existing blob
		if (await this.blobExists(hashHex)) {
			return hashHex;
		}

		// Add to writer
		await this.writer.addBlob(content);
		await this.uploadFinishedPackfiles();

		// Track in session cache
		this.hashCache.add(hashHex);

		return hashHex;
	}

	/**
	 * Store JSON content as a blob
	 */
	async storeJson(data: unknown): Promise<string> {
		const json = JSON.stringify(data);
		const bytes = new TextEncoder().encode(json);
		return this.storeBlob(bytes);
	}

	/**
	 * Flush pending packfiles to R2 and record in database.
	 * Call this periodically during ingest and once at the end.
	 */
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
			// Upload to R2
			await this.withContext(`r2.put(${packfile.key})`, () =>
				this.storage.put(packfile.key, packfile.data),
			);
			console.log(
				`Uploaded packfile ${packfile.key} (${packfile.data.length} bytes, ${packfile.entries.length} blobs)`,
			);

			// Record blob locations in database using batched inserts
			for (let i = 0; i < packfile.entries.length; i += BATCH_SIZE) {
				const batch = packfile.entries.slice(i, i + BATCH_SIZE);
				const statements = batch.map((entry) =>
					this.db
						.prepare(
							`INSERT OR IGNORE INTO blobs (hash, source_id, packfile_key, offset, size)
							 VALUES (?, ?, ?, ?, ?)`,
						)
						.bind(
							hash64ToHex(entry.hash),
							this.sourceId,
							packfile.key,
							entry.offset,
							entry.size,
						),
				);
				await this.withContext(`db.insertBlobs(${packfile.key})`, () =>
					this.db.batch(statements),
				);
				const inserted = Math.min(i + batch.length, packfile.entries.length);
				if (inserted === packfile.entries.length || inserted % 1000 === 0) {
					console.log(
						`Inserted ${inserted}/${packfile.entries.length} blob records for ${packfile.key}`,
					);
				}
			}
		}
	}

	/**
	 * Get the location of a blob by its hash (hex string)
	 */
	async getBlobLocation(hashHex: string): Promise<BlobLocation | null> {
		const cache = await this.loadDbHashes();
		return cache.get(hashHex) || null;
	}
}

/**
 * Read a blob from storage given its location
 */
export async function readBlob(
	storage: R2Bucket,
	location: BlobLocation,
	expectedHashHex: string,
): Promise<Uint8Array> {
	let packfile: R2ObjectBody | null = null;
	try {
		packfile = await storage.get(location.packfileKey, {
			range: {
				offset: location.offset,
				length: location.size,
			},
		});
	} catch (error) {
		console.error(`[BlobStore] r2.get(${location.packfileKey}) failed:`, error);
		throw error;
	}
	if (!packfile) {
		throw new Error(`Packfile not found: ${location.packfileKey}`);
	}

	const packData = new Uint8Array(await packfile.arrayBuffer());
	const { content, hashPrefix } = await extractBlob(packData, 0, location.size);

	const expectedHash = hexToHash64(expectedHashHex);
	if (!verifyHashPrefix(hashPrefix, expectedHash)) {
		throw new Error(
			`Blob hash prefix mismatch for packfile ${location.packfileKey}`,
		);
	}

	return content;
}

/**
 * Read a blob and parse as JSON
 */
export async function readBlobJson<T>(
	storage: R2Bucket,
	location: BlobLocation,
	expectedHashHex: string,
): Promise<T> {
	const content = await readBlob(storage, location, expectedHashHex);
	const json = new TextDecoder().decode(content);
	return JSON.parse(json) as T;
}
