-- Migration: Remove FK constraint on nodes.blob_hash
-- Recreate nodes table (ok to reingest)

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

  -- Blob reference (hash into blobs table)
  blob_hash INTEGER,

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
