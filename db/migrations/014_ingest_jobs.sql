-- Track ingest queue job lifecycle and shard-level progress.

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY,
  source_code TEXT NOT NULL,
  source_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  total_shards INTEGER NOT NULL DEFAULT 0,
  processed_shards INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_created_at
  ON ingest_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status
  ON ingest_jobs(status, updated_at DESC);
