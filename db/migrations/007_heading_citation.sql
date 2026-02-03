-- Migration: Move citation formatting from source level to individual nodes
-- Remove section_name_template from sources and add heading_citation to nodes
--
-- heading_citation examples:
-- - Sections: "CGS § 1-1e", "42 USC 5001"
-- - Chapters: "Chapter 410"
-- - Titles: "Title 22a"

-- Add heading_citation column to nodes table
ALTER TABLE nodes ADD COLUMN heading_citation TEXT;

-- Remove section_name_template from sources (SQLite doesn't support DROP COLUMN in older versions,
-- but D1 uses a newer SQLite version that does)
ALTER TABLE sources DROP COLUMN section_name_template;
