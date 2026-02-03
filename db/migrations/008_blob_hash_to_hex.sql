-- Migration: Switch blob hash fields from INTEGER to TEXT (16-char hex)
-- This requires reingest as we're dropping and recreating the tables.

DROP TABLE IF EXISTS blobs;

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,              -- xxhash64 as 16-char hex string
  packfile_key TEXT NOT NULL,         -- R2 key (e.g., 'cgs/pack-abc123def456.pack')
  offset INTEGER NOT NULL,            -- Byte offset within uncompressed pack
  size INTEGER NOT NULL               -- Blob size in bytes (8-byte prefix + gzip payload)
);

CREATE INDEX IF NOT EXISTS idx_blobs_packfile ON blobs(packfile_key);

-- Recreate nodes table with TEXT blob_hash
DROP TABLE IF EXISTS nodes;

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  source_version_id INTEGER NOT NULL REFERENCES source_versions(id),
  string_id TEXT NOT NULL,
  parent_id INTEGER REFERENCES nodes(id),

  -- Hierarchy info
  level_name TEXT NOT NULL,
  level_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Display info
  name TEXT,
  path TEXT,
  readable_id TEXT,
  heading_citation TEXT,

  -- Blob reference (16-char hex hash into blobs table)
  blob_hash TEXT,

  -- Source tracking
  source_url TEXT,
  accessed_at TEXT,

  UNIQUE(string_id, source_version_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_version ON nodes(source_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(source_version_id, path);
CREATE INDEX IF NOT EXISTS idx_nodes_string_id ON nodes(string_id);
CREATE INDEX IF NOT EXISTS idx_nodes_source_url ON nodes(source_url);
CREATE INDEX IF NOT EXISTS idx_nodes_blob_hash ON nodes(blob_hash);
