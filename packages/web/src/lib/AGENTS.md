# Lib Guide

This directory holds shared web-side logic, including amendment semantics and generic utilities.

- Keep generic utilities here only if they are not redline orchestration.
- Redline-specific orchestration belongs under `redline/`.
- Amendment semantic infrastructure lives in `amendment-edit-planner` and `amendment-edit-tree-apply`.
- If a change affects parsing or PDF flow, read `./redline/AGENTS.md`.
- If a change affects edit planning or apply behavior, read `../../../../docs/agents/redline-application.md`.

## Files

- `amended-snippet-render.tsx`: renders amendment results into snippet-friendly UI fragments.
- `amendment-ast-to-edit-tree.ts`: translates parsed instruction ASTs into semantic edit trees.
- `amendment-document-model.ts`: canonical document model used for amendment planning and apply.
- `amendment-edit-apply-transaction.ts`: applies planned patches as a transaction-like operation.
- `amendment-edit-canonical-update.ts`: materializes canonical-document updates into renderable changes.
- `amendment-edit-engine-types.ts`: shared types for planner and apply logic.
- `amendment-edit-operation-adapter.ts`: adapts semantic edit nodes into planner operations.
- `amendment-edit-patch-utils.ts`: helpers for working with amendment patch structures.
- `amendment-edit-planner.ts`: planner entrypoint for converting edit trees into operations.
- `amendment-edit-tree-apply.ts`: public apply entrypoint for amendment edit trees.
- `amendment-edit-tree.ts`: core semantic tree types and helpers.
- `anchor-search.ts`: text-anchor searching utilities.
- `beam-paragraph-splitter.ts`: paragraph splitting logic based on beam-style heuristics.
- `cluster-indentation.ts`: indentation clustering helpers for extracted text.
- `db.ts`: web-side database access helpers.
- `hierarchy-stack.ts`: utilities for tracking hierarchical text structure.
- `inserted-block-format.ts`: formatting helpers for inserted amendment blocks.
- `lru-cache.ts`: local LRU cache implementation.
- `markdown.test.ts`: tests for markdown rendering or normalization helpers.
- `markdown.ts`: markdown rendering helpers for amendment output.
- `marker-level-inference.ts`: infers list-marker depth or structural level.
- `routes.ts`: route definitions or route helpers for the web app.
- `rules-paragraph-condenser-3.ts`: paragraph condensation heuristics.
- `sentence-segment.ts`: sentence segmentation helpers.
- `text-extract.ts`: general PDF text extraction helpers used outside redline-specific orchestration.
- `text-normalization.ts`: text normalization helpers.
- `text-spans.ts`: utilities for span-based text operations.
- `text.ts`: shared text utilities.
- `types.ts`: shared package-local types for `src/lib`.
- `word-dictionary.ts`: dictionary lookups or word-list helpers.
- `words.txt`: backing word list used by text helpers.
