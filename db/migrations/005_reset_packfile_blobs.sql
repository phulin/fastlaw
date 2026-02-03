-- Migration: Reset blob storage for gzip-in-tar packfiles
-- Ok to require reingest: drop existing blob index and recreate

DROP TABLE IF EXISTS blobs;

CREATE TABLE IF NOT EXISTS blobs (
  hash INTEGER PRIMARY KEY,           -- xxhash64 of blob content (signed 64-bit)
  packfile_key TEXT NOT NULL,         -- R2 key (e.g., 'cgs/pack-abc123def456.pack')
  offset INTEGER NOT NULL,            -- Byte offset within uncompressed pack
  size INTEGER NOT NULL               -- Blob size in bytes (8-byte prefix + gzip payload)
);

CREATE INDEX IF NOT EXISTS idx_blobs_packfile ON blobs(packfile_key);
