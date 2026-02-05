-- Drop foreign key constraint from nodes.parent_id by rebuilding the table

PRAGMA foreign_keys=off;

CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  parent_id TEXT,

  -- Hierarchy info
  level_name TEXT NOT NULL,
  level_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Display info
  name TEXT,
  path TEXT,
  readable_id TEXT,
  heading_citation TEXT,

  -- Blob reference
  blob_hash TEXT,

  -- Source tracking
  source_url TEXT,
  accessed_at TEXT
);

INSERT INTO nodes_new (
  id,
  source_version_id,
  parent_id,
  level_name,
  level_index,
  sort_order,
  name,
  path,
  readable_id,
  heading_citation,
  blob_hash,
  source_url,
  accessed_at
)
SELECT
  id,
  source_version_id,
  parent_id,
  level_name,
  level_index,
  sort_order,
  name,
  path,
  readable_id,
  heading_citation,
  blob_hash,
  source_url,
  accessed_at
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;

CREATE INDEX idx_nodes_version ON nodes(source_version_id);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX idx_nodes_path ON nodes(source_version_id, path);
CREATE INDEX idx_nodes_source_url ON nodes(source_url);
CREATE INDEX idx_nodes_blob_hash ON nodes(blob_hash);

PRAGMA foreign_keys=on;
