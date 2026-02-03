-- Migration: Rename slug to path column in nodes table
-- This adds a new path column and copies data from slug

-- Add the new path column if it doesn't exist
ALTER TABLE nodes ADD COLUMN path TEXT;

-- Copy slug values to path
UPDATE nodes SET path = slug;

-- Drop the old slug column and index
DROP INDEX IF EXISTS idx_nodes_slug;

ALTER TABLE nodes DROP COLUMN slug;

CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(source_version_id, path);
