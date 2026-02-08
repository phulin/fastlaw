import type { IngestSourceCode } from "../types";

export type IngestJobStatus =
	| "planning"
	| "running"
	| "completed"
	| "completed_with_errors"
	| "failed";

export interface IngestJobRecord {
	id: string;
	source_code: IngestSourceCode;
	source_version_id: string | null;
	status: IngestJobStatus;
	total_titles: number;
	processed_titles: number;
	error_count: number;
	last_error: string | null;
	started_at: string;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
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
