-- Migration: Rename label to name and drop name column in nodes table
-- Previous: nodes had both 'label' and 'name' columns
-- After: nodes will only have 'name' column (previously 'label')

BEGIN TRANSACTION;

-- Copy data from label to name, then drop the name column if it exists
-- First, drop the old name column if it exists
ALTER TABLE nodes DROP COLUMN name;

-- Rename label to name
ALTER TABLE nodes RENAME COLUMN label TO name;

COMMIT;
