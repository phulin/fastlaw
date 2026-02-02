-- Metadata only; full content stored in R2
-- Generic sources + levels + documents

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,             -- 'cgs', 'usc', 'ct_regs'
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,      -- 'state' | 'federal'
  region TEXT NOT NULL,            -- 'CT' | 'US' | 'NY'
  doc_type TEXT NOT NULL,          -- 'statute' | 'regulation' | 'case'
  edition TEXT,
  citation_prefix TEXT,
  slug TEXT NOT NULL,              -- URL prefix (e.g., 'cgs')
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  title TEXT,
  citation TEXT,
  slug TEXT NOT NULL,              -- URL path + R2 path (append '.json')
  as_of TEXT,
  effective_start TEXT,
  effective_end TEXT,
  source_url TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS levels (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  level_index INTEGER NOT NULL,    -- 0..n (breadcrumb order)
  level_name TEXT NOT NULL,        -- 'title', 'chapter', 'section', etc
  label TEXT,
  identifier TEXT,
  identifier_sort TEXT,
  name TEXT,
  parent_id TEXT,
  doc_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  slug TEXT                        -- URL path (e.g., 'statutes/cgs/title/1')
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
CREATE INDEX IF NOT EXISTS idx_levels_source ON levels(source_id, doc_type, level_index);
CREATE INDEX IF NOT EXISTS idx_levels_parent ON levels(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_levels_slug ON levels(slug);
