import type {
	DatabaseClient,
	ObjectStore,
	ObjectStoreGetOptions,
	ObjectStoreListResult,
	PreparedStatement,
} from "../types";

export function createD1DatabaseClient(db: D1Database): DatabaseClient {
	return {
		prepare(sql: string): PreparedStatement {
			return db.prepare(sql) as unknown as PreparedStatement;
		},
		batch(statements: PreparedStatement[]) {
			return db.batch(statements as unknown as D1PreparedStatement[]);
		},
	};
}

export function createR2ObjectStore(bucket: R2Bucket): ObjectStore {
	return {
		async get(key: string, options?: ObjectStoreGetOptions) {
			return bucket.get(key, options);
		},
		async put(key: string, value: ArrayBuffer | Uint8Array | string) {
			await bucket.put(key, value);
		},
		async list(options?: {
			prefix?: string;
			limit?: number;
			cursor?: string;
		}): Promise<ObjectStoreListResult> {
			const result = await bucket.list(options);
			return {
				objects: result.objects.map((obj) => ({
					key: obj.key,
					size: obj.size,
					etag: obj.etag,
					uploaded: obj.uploaded.toISOString(),
				})),
				truncated: result.truncated,
				cursor: "cursor" in result ? result.cursor : undefined,
			};
		},
		async delete(keys: string[]) {
			await bucket.delete(keys);
		},
	};
}
