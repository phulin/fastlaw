# Lib Tests Guide

This directory holds focused tests for lower-level web logic.

- Add tests here when the behavior belongs to `src/lib` rather than a route or UI surface.
- Prefer targeted regression tests over broad snapshots.
- Keep fixtures small and representative.
- If the change is redline-specific, also inspect the nearest guide under `../redline/` or `../../../../../docs/agents/redline-application.md`.

## Files

- `amendment-edit-tree-apply.test.ts`: focused tests for amendment tree application behavior.
- `amendment-edit-tree-random-integration.test.ts`: broader integration-style tests for amendment tree execution.
- `text-extract.test.ts`: tests for PDF text extraction and paragraph splitting behavior.
