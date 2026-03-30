# Core Ingest Guide

This directory holds ingest core abstractions such as adapter types and node-store behavior.

- Keep shared ingest primitives narrow and explicit.
- Do not over-generalize adapter contracts.
- Changes here affect multiple jurisdictions; validate cross-jurisdiction impact.
- Read `../../../../../docs/agents/ingest-jurisdiction.md` before refactoring.

## Files

- `adapter-types.ts`: shared ingest adapter interfaces and types.
- `node-store.ts`: node persistence and storage helpers for ingest output.
