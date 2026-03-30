# Redline PDF Guide

This directory holds PDF-side models and instruction-related helpers for the redline pipeline.

- Keep PDF-facing models and helpers here.
- Push heavy processing logic into `processing/`.
- Keep debug-only helpers separate from core flow.
- Read `../../../../../../docs/agents/redline-pipeline.md` for pipeline expectations.

## Files

- `instruction-utils.test.ts`: tests for PDF-side instruction utility behavior.
- `models.ts`: shared PDF redline models and data structures.
