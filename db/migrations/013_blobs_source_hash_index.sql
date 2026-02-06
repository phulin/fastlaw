-- Add composite index for source-scoped hash lookups in blobs

CREATE INDEX IF NOT EXISTS idx_blobs_source_hash
  ON blobs(source_id, hash);
