-- Add index on canonical_name for efficient lookup by version identifier
-- canonical_name format: <source>-<version> (e.g., 'cgs-2025', 'usc-2024')
CREATE INDEX IF NOT EXISTS idx_source_versions_canonical
  ON source_versions(canonical_name);
