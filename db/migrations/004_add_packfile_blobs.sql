-- Migration: Add packfile-based blob storage
-- Blobs are stored in .pack packfiles, indexed by xxhash64

-- New blobs table: maps content hash to packfile location
CREATE TABLE IF NOT EXISTS blobs (
  hash INTEGER PRIMARY KEY,           -- xxhash64 of blob content (signed 64-bit)
  packfile_key TEXT NOT NULL,         -- R2 key (e.g., 'cgs/pack-abc123def456.pack')
  offset INTEGER NOT NULL,            -- Byte offset within uncompressed tar
  size INTEGER NOT NULL               -- Blob size in bytes
);

CREATE INDEX IF NOT EXISTS idx_blobs_packfile ON blobs(packfile_key);

-- Migrate nodes table: replace blob_key/offset/size with blob_hash reference
-- SQLite doesn't support DROP COLUMN in older versions, so we recreate the table

CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY,
  source_version_id INTEGER NOT NULL REFERENCES source_versions(id),
  string_id TEXT NOT NULL,
  parent_id INTEGER REFERENCES nodes_new(id),

  level_name TEXT NOT NULL,
  level_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,

  name TEXT,
  path TEXT,
  readable_id TEXT,

  -- New: reference to blobs table by hash
  blob_hash INTEGER REFERENCES blobs(hash),

  source_url TEXT,
  accessed_at TEXT,

  UNIQUE(string_id, source_version_id)
);

-- Copy data (blob references will be NULL, requiring re-ingest)
INSERT INTO nodes_new (
  id, source_version_id, string_id, parent_id,
  level_name, level_index, sort_order,
  name, path, readable_id,
  source_url, accessed_at
)
SELECT
  id, source_version_id, string_id, parent_id,
  level_name, level_index, sort_order,
  name, path, readable_id,
  source_url, accessed_at
FROM nodes;

-- Drop old table and rename
DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_nodes_version ON nodes(source_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(source_version_id, path);
CREATE INDEX IF NOT EXISTS idx_nodes_string_id ON nodes(string_id);
CREATE INDEX IF NOT EXISTS idx_nodes_source_url ON nodes(source_url);
CREATE INDEX IF NOT EXISTS idx_nodes_blob_hash ON nodes(blob_hash);
