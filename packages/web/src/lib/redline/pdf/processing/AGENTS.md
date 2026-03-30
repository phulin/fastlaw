# PDF Processing Guide

This directory holds the main PDF processing worker and page-item assembly logic.

- Keep windowing, extraction, and processing orchestration here.
- Do not hide semantic rule changes inside worker glue.
- Changes here often affect performance and runtime boundaries as well as correctness.
- Read `../../../../../../../docs/agents/redline-pipeline.md` and `../../../../../../../docs/agents/web-runtime-boundaries.md` before major edits.

## Files

- `build-page-items.ts`: assembles processed page items, annotations, and amendment effects.
- `instruction-utils.ts`: processing-time helpers for instruction handling and normalization.
- `worker-types.ts`: message and payload types for the PDF processing worker.
- `worker.ts`: background worker entrypoint for PDF processing.
