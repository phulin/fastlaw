import { hash64, hash64ToHex, hexToHash64, verifyHashPrefix } from "./hash";
import { extractBlob, PackfileWriter } from "./writer";

export interface BlobLocation {
	packfileKey: string;
	offset: number;
	size: number;
}

const BATCH_SIZE = 50;
const HASH_CHECK_BATCH = 50;

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
	private sourceId: string;
	private writer: PackfileWriter;
	private hashCache: Set<string> = new Set(); // Track hashes we've seen this session (hex strings)

	constructor(
		db: D1Database,
		storage: R2Bucket,
		sourceId: string,
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
	 * Check which hashes exist in the DB for this source.
	 */
	private async getExistingHashes(hashes: string[]): Promise<Set<string>> {
		if (hashes.length === 0) {
			return new Set();
		}
		const existing = new Set<string>();

		for (let i = 0; i < hashes.length; i += HASH_CHECK_BATCH) {
			const batch = hashes.slice(i, i + HASH_CHECK_BATCH);
			const placeholders = batch.map(() => "?").join(", ");
			const result = await this.withContext("db.hashExists", () =>
				this.db
					.prepare(
						`SELECT hash FROM blobs
						 WHERE source_id = ? AND hash IN (${placeholders})`,
					)
					.bind(this.sourceId, ...batch)
					.all<{ hash: string }>(),
			);
			for (const row of result.results) {
				existing.add(row.hash);
			}
		}

		return existing;
	}

	/**
	 * Store multiple blobs, returning their hashes as hex strings.
	 * Uses batched existence checks to avoid full preloads.
	 */
	async storeBlobBatch(contents: Uint8Array[]): Promise<string[]> {
		if (contents.length === 0) {
			return [];
		}

		const items = await Promise.all(
			contents.map(async (content) => ({
				content,
				hashHex: hash64ToHex(await hash64(content)),
			})),
		);

		const hashToContent = new Map<string, Uint8Array>();
		const hashesToCheck: string[] = [];

		for (const item of items) {
			if (!hashToContent.has(item.hashHex)) {
				hashToContent.set(item.hashHex, item.content);
			}
			if (!this.hashCache.has(item.hashHex)) {
				hashesToCheck.push(item.hashHex);
			}
		}

		const uniqueHashesToCheck = Array.from(new Set(hashesToCheck));
		const newHashes = new Set<string>();

		for (let i = 0; i < uniqueHashesToCheck.length; i += HASH_CHECK_BATCH) {
			const batch = uniqueHashesToCheck.slice(i, i + HASH_CHECK_BATCH);
			const existing = await this.getExistingHashes(batch);
			for (const hash of batch) {
				if (!existing.has(hash)) {
					newHashes.add(hash);
				}
				this.hashCache.add(hash);
			}
		}

		for (const hash of newHashes) {
			const content = hashToContent.get(hash);
			if (!content) {
				throw new Error(`Missing content for hash ${hash}`);
			}
			await this.writer.addBlob(content);
		}

		await this.uploadFinishedPackfiles();

		return items.map((item) => item.hashHex);
	}

	/**
	 * Store a blob, returning its hash as a hex string.
	 * If the blob already exists (by hash), it won't be stored again.
	 */
	async storeBlob(content: Uint8Array): Promise<string> {
		const [hash] = await this.storeBlobBatch([content]);
		return hash;
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
	 * Store JSON content as blobs
	 */
	async storeJsonBatch(data: unknown[]): Promise<string[]> {
		const contents = data.map((item) =>
			new TextEncoder().encode(JSON.stringify(item)),
		);
		return this.storeBlobBatch(contents);
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
		const result = await this.withContext("db.getBlobLocation", () =>
			this.db
				.prepare(
					`SELECT packfile_key, offset, size FROM blobs
					 WHERE source_id = ? AND hash = ?`,
				)
				.bind(this.sourceId, hashHex)
				.first<{
					packfile_key: string;
					offset: number;
					size: number;
				}>(),
		);

		if (!result) {
			return null;
		}

		return {
			packfileKey: result.packfile_key,
			offset: result.offset,
			size: result.size,
		};
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
