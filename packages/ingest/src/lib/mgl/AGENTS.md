# MGL Guide

This directory holds Massachusetts General Laws ingestion logic on the TypeScript side.

- Keep MGL-specific adapter, parser, and helper behavior here.
- Preserve deterministic output and cross-reference behavior.
- Read `../../../../../docs/agents/ingest-jurisdiction.md` before major edits.

## Files

- `adapter.ts`: MGL adapter entrypoint for ingest integration.
- `cross-references.ts`: MGL cross-reference extraction and normalization.
- `fetcher.ts`: MGL-specific fetch logic.
- `parser.ts`: MGL parsing logic.
- `utils.ts`: MGL-specific helper utilities.
