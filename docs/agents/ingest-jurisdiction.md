# Ingest Jurisdiction Guide

## When To Read

- adding a new jurisdiction
- modifying a jurisdiction adapter
- changing hierarchy extraction, IDs, or source-version handling

## Expected Output

- stable hierarchy
- deterministic ordering
- section text and relevant metadata
- outputs that are safe to retry and compare across runs

## Implementation Pattern

1. Start from the source shape and publication format.
2. Write fixtures or tests for structure and tricky content first.
3. Implement the adapter or parser.
4. Validate on representative edge cases, not just happy paths.

## Invariants

- IDs should be deterministic.
- Memory use should stay bounded.
- Persistence should be batched.
- Source version handling should be explicit and inspectable.

## Files To Inspect First

- The closest existing jurisdiction with a similar source shape
- Core ingest primitives used by that jurisdiction
- Relevant fixtures and tests under `src/__tests__`

## Verification

- Run `yarn workspace @fastlaw/ingest test`
- Run `yarn check:fix && yarn typecheck`
- Spot-check structure and content on tricky sections
