-- Migration: Add slugs to existing levels
-- This migration adds the slug column and updates existing level records

-- Add slug column
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- This migration assumes the column doesn't exist yet (fresh migration)
ALTER TABLE levels ADD COLUMN slug TEXT;

-- Update CGS title levels
UPDATE levels
SET slug = 'statutes/cgs/title/' || identifier
WHERE source_id = 'cgs'
  AND level_name = 'title'
  AND slug IS NULL;

-- Update CGS chapter levels
UPDATE levels
SET slug = 'statutes/cgs/chapter/' || identifier
WHERE source_id = 'cgs'
  AND level_name = 'chapter'
  AND slug IS NULL;

-- Update CGS section levels
UPDATE levels
SET slug = 'statutes/cgs/section/' || REPLACE(identifier, '-', '/')
WHERE source_id = 'cgs'
  AND level_name = 'section'
  AND slug IS NULL;

-- Verify migration results
SELECT
    source_id,
    level_name,
    COUNT(*) as total_count,
    COUNT(slug) as with_slug_count,
    COUNT(*) - COUNT(slug) as without_slug_count
FROM levels
GROUP BY source_id, level_name
ORDER BY source_id, level_name;
