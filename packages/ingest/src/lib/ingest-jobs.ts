import type { IngestSourceCode } from "../types";

export type IngestJobStatus =
	| "planning"
	| "running"
	| "completed"
	| "completed_with_errors"
	| "failed";

export type IngestJobUnitStatus =
	| "pending"
	| "running"
	| "completed"
	| "skipped"
	| "error";

export interface IngestJobRecord {
	id: string;
	source_code: IngestSourceCode;
	source_version_id: string | null;
	status: IngestJobStatus;
	total_titles: number;
	processed_titles: number;
	total_nodes: number;
	processed_nodes: number;
	error_count: number;
	last_error: string | null;
	started_at: string;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface IngestJobUnitRecord {
	id: number;
	job_id: string;
	unit_id: string;
	status: IngestJobUnitStatus;
	total_nodes: number;
	processed_nodes: number;
	error: string | null;
	started_at: string | null;
	completed_at: string | null;
}

export async function createIngestJob(
	db: D1Database,
	sourceCode: IngestSourceCode,
): Promise<string> {
	const jobId = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO ingest_jobs (
				id, source_code, status
			) VALUES (?, ?, 'planning')`,
		)
		.bind(jobId, sourceCode)
		.run();
	return jobId;
}

export async function createJobUnits(
	db: D1Database,
	jobId: string,
	unitIds: string[],
): Promise<void> {
	const BATCH_SIZE = 50;
	for (let i = 0; i < unitIds.length; i += BATCH_SIZE) {
		const batch = unitIds.slice(i, i + BATCH_SIZE);
		const statements = batch.map((unitId) =>
			db
				.prepare(
					`INSERT INTO ingest_job_units (job_id, unit_id, status)
					VALUES (?, ?, 'pending')`,
				)
				.bind(jobId, unitId),
		);
		await db.batch(statements);
	}
}

export async function markUnitRunning(
	db: D1Database,
	jobId: string,
	unitId: string,
	totalNodes: number,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE ingest_job_units
				SET status = 'running', total_nodes = ?, started_at = CURRENT_TIMESTAMP
				WHERE job_id = ? AND unit_id = ?`,
			)
			.bind(totalNodes, jobId, unitId),
		db
			.prepare(
				`UPDATE ingest_jobs
				SET total_nodes = total_nodes + ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ?`,
			)
			.bind(totalNodes, jobId),
	]);
}

export async function incrementUnitProcessedNodes(
	db: D1Database,
	jobId: string,
	unitId: string,
	count: number,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE ingest_job_units
				SET processed_nodes = processed_nodes + ?
				WHERE job_id = ? AND unit_id = ?`,
			)
			.bind(count, jobId, unitId),
		db
			.prepare(
				`UPDATE ingest_jobs
				SET processed_nodes = processed_nodes + ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ?`,
			)
			.bind(count, jobId),
	]);
}

export async function markUnitCompleted(
	db: D1Database,
	jobId: string,
	unitId: string,
	status: "completed" | "skipped" | "error",
	error?: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ingest_job_units
			SET
				status = ?,
				error = ?,
				completed_at = CURRENT_TIMESTAMP
			WHERE job_id = ? AND unit_id = ?`,
		)
		.bind(status, error?.slice(0, 1000) ?? null, jobId, unitId)
		.run();
}

export async function completePlanning(
	db: D1Database,
	jobId: string,
	sourceVersionId: string,
	totalTitles: number,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ingest_jobs
			SET
				source_version_id = ?,
				total_titles = ?,
				status = CASE
					WHEN ? = 0 THEN 'completed'
					WHEN processed_titles >= ? THEN
						CASE
							WHEN error_count > 0 THEN 'completed_with_errors'
							ELSE 'completed'
						END
					ELSE 'running'
				END,
				completed_at = CASE
					WHEN ? = 0 OR processed_titles >= ? THEN CURRENT_TIMESTAMP
					ELSE completed_at
				END,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ?`,
		)
		.bind(
			sourceVersionId,
			totalTitles,
			totalTitles,
			totalTitles,
			totalTitles,
			totalTitles,
			jobId,
		)
		.run();
}

export async function markPlanningFailed(
	db: D1Database,
	jobId: string,
	errorMessage: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ingest_jobs
			SET
				status = 'failed',
				error_count = error_count + 1,
				last_error = ?,
				completed_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ?`,
		)
		.bind(errorMessage.slice(0, 1000), jobId)
		.run();
}

export async function incrementProcessedTitles(
	db: D1Database,
	jobId: string,
	count: number,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ingest_jobs
			SET
				processed_titles = processed_titles + ?,
				status = CASE
					WHEN status = 'planning' THEN 'planning'
					WHEN processed_titles + ? >= total_titles THEN
						CASE
							WHEN error_count > 0 THEN 'completed_with_errors'
							ELSE 'completed'
						END
					ELSE status
				END,
				completed_at = CASE
					WHEN status != 'planning' AND processed_titles + ? >= total_titles
						THEN CURRENT_TIMESTAMP
					ELSE completed_at
				END,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('planning', 'running', 'completed_with_errors')`,
		)
		.bind(count, count, count, jobId)
		.run();
}

export async function recordTitleError(
	db: D1Database,
	jobId: string,
	errorMessage: string,
	finalFailure: boolean,
): Promise<void> {
	await db
		.prepare(
			`UPDATE ingest_jobs
			SET
				error_count = error_count + 1,
				last_error = ?,
				status = CASE
					WHEN ? THEN 'failed'
					ELSE status
				END,
				completed_at = CASE
					WHEN ? THEN CURRENT_TIMESTAMP
					ELSE completed_at
				END,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('planning', 'running', 'completed_with_errors')`,
		)
		.bind(
			errorMessage.slice(0, 1000),
			finalFailure ? 1 : 0,
			finalFailure ? 1 : 0,
			jobId,
		)
		.run();
}
