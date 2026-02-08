-- Per-unit progress tracking for ingest jobs.

CREATE TABLE IF NOT EXISTS ingest_job_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES ingest_jobs(id),
  unit_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total_nodes INTEGER NOT NULL DEFAULT 0,
  processed_nodes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(job_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_job_units_job
  ON ingest_job_units(job_id);

ALTER TABLE ingest_jobs ADD COLUMN total_nodes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN processed_nodes INTEGER NOT NULL DEFAULT 0;
