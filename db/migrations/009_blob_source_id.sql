-- Migration: Add source_id to blobs table for efficient querying
-- This avoids using LIKE on packfile_key for source filtering.
-- Requires reingest as we're dropping and recreating the table.

DROP TABLE IF EXISTS blobs;

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,              -- xxhash64 as 16-char hex string
  source_id INTEGER NOT NULL REFERENCES sources(id),
  packfile_key TEXT NOT NULL,         -- R2 key (e.g., 'cgs/pack-abc123def456.pack')
  offset INTEGER NOT NULL,            -- Byte offset within uncompressed pack
  size INTEGER NOT NULL               -- Blob size in bytes (8-byte prefix + gzip payload)
);

CREATE INDEX IF NOT EXISTS idx_blobs_source ON blobs(source_id);
CREATE INDEX IF NOT EXISTS idx_blobs_packfile ON blobs(packfile_key);
