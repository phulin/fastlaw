-- Connecticut Statutes D1 Schema
-- Metadata only; full content stored in R2

-- Titles (top-level grouping)
CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,              -- '21a'
  id_padded TEXT,                   -- '0021a' for sorting
  id_display TEXT,                  -- '21A' for display
  name TEXT,                        -- 'Consumer Protection'
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Chapters (browsable via /statutes/cgs/chapter/{id})
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,              -- 'chap_420d' or '420d'
  id_padded TEXT,                   -- '0420d' for sorting
  id_display TEXT,                  -- '420D' for display
  title_id TEXT NOT NULL,           -- references titles(id)
  title_id_padded TEXT,
  title_id_display TEXT,
  name TEXT NOT NULL,               -- 'Palliative Use of Marijuana'
  section_count INTEGER DEFAULT 0,
  section_start TEXT,
  section_end TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Sections (metadata only; full content in R2)
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,              -- 'sec_21a-279' or '21a-279'
  title_id TEXT NOT NULL,
  chapter_id TEXT,
  section_number TEXT NOT NULL,     -- '21a-279'
  section_label TEXT,               -- 'Sec. 21a-279.'
  heading TEXT,                     -- 'Penalty for illegal manufacture...'
  r2_key TEXT NOT NULL,             -- Key to full content JSON in R2
  see_also TEXT,                    -- JSON array of related section IDs
  prev_section_id TEXT,
  next_section_id TEXT,
  prev_section_label TEXT,
  next_section_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Indexes for browsing
CREATE INDEX IF NOT EXISTS idx_sections_title ON sections(title_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_sections_chapter ON sections(chapter_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_sections_number ON sections(section_number);
CREATE INDEX IF NOT EXISTS idx_chapters_title ON chapters(title_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_chapters_id_display ON chapters(id_display);
CREATE INDEX IF NOT EXISTS idx_titles_id_padded ON titles(id_padded);
