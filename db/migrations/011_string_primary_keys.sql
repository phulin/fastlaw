-- Drop and recreate tables with string primary keys for sources, source_versions, and nodes

DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS blobs;
DROP TABLE IF EXISTS source_versions;
DROP TABLE IF EXISTS sources;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  region TEXT NOT NULL,
  doc_type TEXT NOT NULL
);

CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  version_date TEXT NOT NULL,
  root_node_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_source_versions_latest
  ON source_versions(source_id, version_date DESC);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  parent_id TEXT REFERENCES nodes(id),

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

CREATE INDEX idx_nodes_version ON nodes(source_version_id);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX idx_nodes_path ON nodes(source_version_id, path);
CREATE INDEX idx_nodes_source_url ON nodes(source_url);
CREATE INDEX idx_nodes_blob_hash ON nodes(blob_hash);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  packfile_key TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE INDEX idx_blobs_source ON blobs(source_id);
CREATE INDEX idx_blobs_packfile ON blobs(packfile_key);
