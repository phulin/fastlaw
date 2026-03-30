# Ingest Tests Guide

This directory holds TypeScript-side ingest tests.

- Add focused tests here for ingest Worker and adapter behavior.
- Prefer fixture-backed tests for parser and hierarchy regressions.
- Keep tests close to real source behavior rather than synthetic abstractions.
- Read `../../../../docs/agents/ingest-jurisdiction.md` when adding jurisdiction behavior.

## Files

- `cga.test.ts`: TypeScript-side tests for CGA ingest behavior.
- `cross-references.test.ts`: tests for cross-reference extraction or normalization.
- `mgl.test.ts`: TypeScript-side tests for MGL ingest behavior.
- `usc-packfile-flush.test.ts`: tests for USC-related packfile flushing behavior.
