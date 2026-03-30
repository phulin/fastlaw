# Redline Pipeline Guide

## When To Read

- PDF extraction changes
- instruction discovery or parser changes
- redline processing pipeline refactors
- changes inside `packages/web/src/lib/redline`

## Current Boundaries

- `src/lib/redline/pdf`: PDF models, extraction helpers, processing workers, page assembly.
- `src/lib/redline/amendment-parser`: grammar-backed parser implementation.
- `src/lib/amendment-edit-planner` and `src/lib/amendment-edit-tree-apply`: semantic machinery used by the pipeline, but not part of redline orchestration itself.
- `PdfApp.tsx` and related UI code orchestrate the pipeline. Keep core parsing and processing logic out of the UI layer.

## Pipeline Overview

The current path is:

1. PDF input and text extraction
2. paragraph and instruction span discovery
3. grammar-backed parsing
4. semantic translation into edit structures
5. planning and application against target section text
6. rendered annotations and amended snippets

## Files To Inspect First

- The current UI or worker entrypoint driving the task
- `src/lib/redline/amendment-parser/create-handcrafted-instruction-parser.ts`
- `src/lib/redline/pdf/processing/worker.ts`
- `src/lib/redline/pdf/processing/build-page-items.ts`
- The closest focused test covering the changed behavior

## Invariants

- Parse spans should be deterministic.
- A paragraph should not ambiguously belong to multiple instruction spans.
- Parser-native data should drive downstream processing where supported.
- Keep redline-specific orchestration inside `src/lib/redline`.

## Test Strategy

- Add grammar/parser tests for syntax coverage changes.
- Add processing tests for page assembly or instruction extraction changes.
- Extend integration coverage when changes affect rendered amendment outcomes.

## Deep Reference

- Use `../design/parser-ast-edit-tree-transition.md` for the migration rationale and parser-first end state.
