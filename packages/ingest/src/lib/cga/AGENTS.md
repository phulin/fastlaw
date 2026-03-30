# CGA Guide

This directory holds Connecticut General Assembly ingestion logic on the TypeScript side.

- Keep CGA-specific adapter, parser, and helper behavior here.
- Changes here often interact with workflow helpers and source-version handling.
- Preserve deterministic structure and retry-safe behavior.
- Read `../../../../../docs/agents/ingest-jurisdiction.md` and `../../../../../docs/agents/cloudflare-workflows.md` before major edits.

## Files

- `adapter.ts`: CGA adapter entrypoint for ingest integration.
- `cross-references.ts`: CGA cross-reference extraction and normalization.
- `parser.ts`: CGA parsing logic.
- `utils.ts`: CGA-specific helper utilities.
- `workflow-helpers.ts`: CGA Cloudflare workflow support helpers.
