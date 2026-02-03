-- Migration: Add section_name_template column to sources table
-- Template uses %ID% placeholder that gets substituted with readable_id on render
-- For USC: template is '%ID%' (e.g., "42 USC 5001")
-- For CGA: template is 'CGS § %ID%' (e.g., "CGS § 1-310")

ALTER TABLE sources ADD COLUMN section_name_template TEXT;
