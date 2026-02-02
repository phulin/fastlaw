-- Metadata only; body JSON stored in object storage with range reads
-- Blobs grouped by source + top-level division (e.g., usc/2024/title-1.json)

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,         -- 'usc', 'cfr', 'cgs', etc.
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,        -- 'federal', 'state'
  region TEXT NOT NULL,              -- 'US', 'CT', 'NY'
  doc_type TEXT NOT NULL             -- 'statute', 'regulation', 'case'
);

CREATE TABLE IF NOT EXISTS source_versions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  canonical_name TEXT NOT NULL,      -- e.g., 'usc-2024', 'cfr-2024-01-01'
  version_date TEXT NOT NULL,        -- ISO date identifier for this version
  root_node_id INTEGER,              -- Tree root (set after nodes created)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_source_versions_latest
  ON source_versions(source_id, version_date DESC);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  source_version_id INTEGER NOT NULL REFERENCES source_versions(id),
  string_id TEXT NOT NULL,           -- Stable ID across versions (e.g., 'title-1/ch-2/sec-3')
  parent_id INTEGER REFERENCES nodes(id),

  -- Hierarchy info
  level_name TEXT NOT NULL,          -- 'title', 'chapter', 'section', etc.
  level_index INTEGER NOT NULL,      -- Depth in tree (0 = root)
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Display info
  label TEXT,                        -- e.g., '§ 1234'
  name TEXT,                         -- e.g., 'General Provisions'
  slug TEXT,                         -- URL path segment

  -- Blob storage reference for body JSON
  blob_key TEXT,                     -- Object storage key (e.g., 'usc/2024/title-1.json')
  blob_offset INTEGER,               -- Range read start byte
  blob_size INTEGER,                 -- Range read length in bytes

  -- Source tracking
  source_url TEXT,                   -- Original URL this data was fetched from
  accessed_at TEXT,                  -- ISO timestamp when content was fetched

  UNIQUE(string_id, source_version_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_version ON nodes(source_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_nodes_slug ON nodes(source_version_id, slug);
CREATE INDEX IF NOT EXISTS idx_nodes_string_id ON nodes(string_id);
CREATE INDEX IF NOT EXISTS idx_nodes_source_url ON nodes(source_url);

-- Add FK from source_versions.root_node_id after nodes table exists
-- (SQLite doesn't enforce FKs by default anyway)
