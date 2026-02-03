import type {
	DatabaseClient,
	DbAllResult,
	DbBatchResult,
	DbRunResult,
	PreparedStatement,
} from "../../types";

interface D1QueryResult<T = unknown> {
	results: T[];
	meta: {
		last_row_id?: number;
	};
}

interface D1QueryResponse<T = unknown> {
	success: boolean;
	errors: { message: string }[];
	result: D1QueryResult<T>[];
}

class D1HttpPreparedStatement implements PreparedStatement {
	private client: D1HttpClient;
	private sql: string;
	private params: unknown[];

	constructor(client: D1HttpClient, sql: string, params: unknown[] = []) {
		this.client = client;
		this.sql = sql;
		this.params = params;
	}

	bind(...params: unknown[]): PreparedStatement {
		return new D1HttpPreparedStatement(this.client, this.sql, params);
	}

	async run(): Promise<DbRunResult> {
		return this.client.run(this.sql, this.params);
	}

	async all<T = unknown>(): Promise<DbAllResult<T>> {
		return this.client.all<T>(this.sql, this.params);
	}

	async first<T = unknown>(): Promise<T | null> {
		const result = await this.client.all<T>(this.sql, this.params);
		return result.results[0] ?? null;
	}
}

class D1HttpClient implements DatabaseClient {
	private accountId: string;
	private databaseId: string;
	private apiToken: string;

	constructor(accountId: string, databaseId: string, apiToken: string) {
		this.accountId = accountId;
		this.databaseId = databaseId;
		this.apiToken = apiToken;
	}

	prepare(sql: string): PreparedStatement {
		return new D1HttpPreparedStatement(this, sql);
	}

	async batch(statements: PreparedStatement[]): Promise<DbBatchResult[]> {
		const results: DbBatchResult[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	async run(sql: string, params: unknown[]): Promise<DbRunResult> {
		const result = await this.query(sql, params);
		return { meta: result.meta };
	}

	async all<T = unknown>(
		sql: string,
		params: unknown[],
	): Promise<DbAllResult<T>> {
		const result = await this.query<T>(sql, params);
		return { results: result.results };
	}

	private async query<T = unknown>(
		sql: string,
		params: unknown[],
	): Promise<D1QueryResult<T>> {
		const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql, params }),
		});

		if (!response.ok) {
			throw new Error(`D1 HTTP query failed: ${response.status}`);
		}

		const data = (await response.json()) as D1QueryResponse<T>;
		if (!data.success) {
			throw new Error(
				`D1 HTTP query failed: ${data.errors.map((err) => err.message).join("; ")}`,
			);
		}

		return data.result[0];
	}
}

export function createD1HttpClient(env: {
	CF_ACCOUNT_ID: string;
	D1_DATABASE_ID: string;
	D1_API_TOKEN: string;
}): DatabaseClient {
	return new D1HttpClient(
		env.CF_ACCOUNT_ID,
		env.D1_DATABASE_ID,
		env.D1_API_TOKEN,
	);
}
