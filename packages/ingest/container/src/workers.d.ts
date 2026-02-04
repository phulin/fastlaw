interface D1PreparedStatement {
	bind(...args: unknown[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	first<T>(): Promise<T | null>;
	run(): Promise<{ meta: { last_row_id: number } }>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch(
		statements: D1PreparedStatement[],
	): Promise<{ meta: { last_row_id: number } }[]>;
}

interface R2ObjectBody {
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

interface R2Bucket {
	get(
		key: string,
		options?: { range?: { offset: number; length: number } },
	): Promise<R2ObjectBody | null>;
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
	): Promise<void>;
	list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{
		objects: { key: string; size: number; etag: string; uploaded: string }[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string[] | string): Promise<void>;
}

interface Fetcher {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type DurableObjectNamespace = object;
