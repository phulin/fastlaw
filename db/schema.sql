-- Metadata only; body JSON stored in .pack packfiles in object storage
-- Blobs indexed by xxhash64 for deduplication and efficient lookup

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,               -- 'usc', 'cfr', 'cgs', etc.
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,        -- 'federal', 'state'
  region TEXT NOT NULL,              -- 'US', 'CT', 'NY'
  doc_type TEXT NOT NULL             -- 'statute', 'regulation', 'case'
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,              -- xxhash64 as 16-char hex string
  source_id TEXT NOT NULL REFERENCES sources(id),
  packfile_key TEXT NOT NULL,         -- R2 key (e.g., 'cgs/pack-abc123def456.pack')
  offset INTEGER NOT NULL,            -- Byte offset within uncompressed pack
  size INTEGER NOT NULL               -- Blob size in bytes (8-byte prefix + gzip payload)
);

CREATE INDEX IF NOT EXISTS idx_blobs_source ON blobs(source_id);
CREATE INDEX IF NOT EXISTS idx_blobs_packfile ON blobs(packfile_key);

CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,               -- e.g., 'cgs-2025', 'usc-2024'
  source_id TEXT NOT NULL REFERENCES sources(id),
  version_date TEXT NOT NULL,        -- ISO date identifier for this version
  root_node_id TEXT,                 -- Tree root (set after nodes created)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_source_versions_latest
  ON source_versions(source_id, version_date DESC);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,               -- Stable ID across versions (e.g., 'cgs/2025/root/title-1')
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  parent_id TEXT,

  -- Hierarchy info
  level_name TEXT NOT NULL,          -- 'title', 'chapter', 'section', etc.
  level_index INTEGER NOT NULL,      -- Depth in tree (0 = root)
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Display info
  name TEXT,                         -- e.g., 'General Provisions'
  path TEXT,                         -- URL path segment
  readable_id TEXT,                  -- Human-readable identifier for breadcrumbs (e.g., '1-310' for CGA, '42 USC 5001' for USC)
  heading_citation TEXT,             -- Formatted citation for headings (e.g., 'CGS § 1-1e', '42 USC 5001', 'Chapter 410', 'Title 22a')

  -- Blob reference (16-char hex hash into blobs table)
  blob_hash TEXT,

  -- Source tracking
  source_url TEXT,                   -- Original URL this data was fetched from
  accessed_at TEXT                   -- ISO timestamp when content was fetched
);

CREATE INDEX IF NOT EXISTS idx_nodes_version ON nodes(source_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(source_version_id, path);
CREATE INDEX IF NOT EXISTS idx_nodes_source_url ON nodes(source_url);
CREATE INDEX IF NOT EXISTS idx_nodes_blob_hash ON nodes(blob_hash);

-- Add FK from source_versions.root_node_id after nodes table exists
-- (SQLite doesn't enforce FKs by default anyway)
