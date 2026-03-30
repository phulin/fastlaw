# Web Package Guide

This guide covers `packages/web`. Treat the package as four surfaces: app shell and routes, redline pipeline, amendment semantics, and runtime boundaries.

## Directory Map

- `src/pages`: route-level UI.
- `src/components`: reusable UI components.
- `src/server`: server-side logic.
- `src/lib/redline`: redline-specific parsing, PDF models, processing workers, and orchestration.
- `src/lib/amendment-edit-planner`: amendment planning logic.
- `src/lib/amendment-edit-tree-apply`: edit-tree application engine.
- `src/lib/__tests__`: lower-level tests and fixtures.
- `src/styles`: app and PDF UI styling.

## Routing Inside Web

- If changing parsing, PDF extraction, instruction discovery, or redline orchestration, read `../../docs/agents/redline-pipeline.md`.
- If changing amendment planning, edit-tree semantics, or application behavior, read `../../docs/agents/redline-application.md`.
- If changing worker/server/browser boundaries, read `../../docs/agents/web-runtime-boundaries.md`.
- If changing generic UI or routes only, this file is usually enough.

## Local Invariants

- Keep redline-specific orchestration inside `src/lib/redline` unless there is a clear architectural reason not to.
- Do not leak redline-specific concerns into generic app code.
- Treat `amendment-edit-planner` and `amendment-edit-tree-apply` as core semantic infrastructure with higher regression risk than most UI code.
- Keep parser and pipeline behavior deterministic and test-backed.

## Verification

- Default package test command: `yarn workspace @fastlaw/web test`
- Always run repo-wide verification after edits: `yarn check:fix && yarn typecheck`
- For parser or apply changes, add or update focused tests before broader refactors.

## Authoritative Sources

- This file is authoritative for package structure and routing.
- `docs/agents/*` files are authoritative for workflow-specific expectations.
- `docs/design/*` files are reference material for deeper rationale.
