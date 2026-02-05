# Task Plan: String Primary Keys + Schema Migration

## Goal
Switch DB primary keys to string IDs for sources, source versions, and nodes; update code to match; add migration that drops and recreates the tables.

## Phases
- [x] Phase 1: Review schema + current DB access patterns
- [x] Phase 2: Update schema and migration (drop/recreate tables)
- [x] Phase 3: Refactor ingest code for string PKs and no pre-insert
- [x] Phase 4: Verify build checks

## Key Questions
1. Which code paths assume numeric IDs for sources/versions/nodes?
2. How should parent IDs be resolved when each worker inserts its own nodes?

## Decisions Made
- Use string IDs as primary keys for `sources`, `source_versions`, and `nodes`.

## Errors Encountered
- None yet.

## Status
**Complete** - Schema and code updated for string PKs; checks run.
