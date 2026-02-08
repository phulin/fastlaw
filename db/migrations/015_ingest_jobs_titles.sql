-- Rename shard columns to title columns (tracks titles completed, not nodes)
ALTER TABLE ingest_jobs RENAME COLUMN total_shards TO total_titles;
ALTER TABLE ingest_jobs RENAME COLUMN processed_shards TO processed_titles;
