# Schema And Migrations Guide

## When To Read

- migrations
- shared table changes
- index changes
- ingest and web coordination changes that depend on schema updates

## Change Process

1. Inspect the current schema and downstream callsites.
2. Make the schema change directly.
3. Update all consuming code in the repo.
4. Verify both ingest and web assumptions if the schema is shared.

## Invariants

- Prefer clear schema over compatibility glue.
- Do not stage partial backward-compatibility layers inside the repo.
- Keep naming and indexing rationale explicit in the migration itself.

## Verification

- Run `yarn check:fix && yarn typecheck`.
- Run relevant ingest or web tests when the schema change affects runtime behavior.
- Apply migrations locally when the task requires validating migration behavior.
