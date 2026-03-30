# DB Package Guide

This package currently holds migrations and schema-level changes.

## Local Invariants

- Keep migrations straightforward and forward-only.
- Prefer explicit schema changes over compatibility layers.
- When changing shared tables or indexes, inspect both ingest and web callsites.

## Task Routing

- For any non-trivial schema change, read `../../docs/agents/schema-and-migrations.md`.

## Verification

- Run `yarn check:fix && yarn typecheck` after edits.
- Run relevant package tests when the schema change affects ingest or web behavior.
