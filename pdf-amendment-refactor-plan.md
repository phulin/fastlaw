# PDF Amendment Pipeline Refactor Plan

## Constraints
- Preserve runtime behavior and public API.
- Keep existing test suite unchanged.
- Ship in small, low-risk phases.

## Status Summary
- Phase 1 completed.
- Phase 2 completed.
- Phase 3 completed.
- Phase 4 completed.
- Phase 5 largely completed:
  - `PlainDocument` and `DocumentModel` removed.
  - unified `CanonicalDocument` in place.
  - execution rebuild no longer reparses markdown.
  - remaining cleanup is single-source-of-truth execution state.

## Phase 1: Internal Module Decomposition (Completed)
- Split `packages/web/src/lib/amendment-edit-tree-apply.ts` into internal modules by concern:
  - `resolve/*`: path normalization and target resolution helpers.
  - `execute/*`: sequential execution helpers.
  - `summary/*`: failure reason mapping + apply summary shaping.
- Keep `applyAmendmentEditTreeToSection` exported from the original file as a facade.
- Move code only; do not alter branching or matching behavior.

## Phase 2: Planner Handler Split (Completed)
- Split edit-kind handling in `amendment-edit-planner.ts` into per-kind modules.
- Keep `planOperationEdit` and `planEdits` signatures/behavior unchanged.

## Phase 3: Shared Patch/Attempt Utilities (Completed)
- Deduplicate patch conflict and attempt-outcome bookkeeping.

## Phase 4: Rebuild Model Boundary (Completed)
- Encapsulated model-update flow in execute helpers.

## Phase 5: Canonical Document Unification (Completed Core)
- Replace dual model flow with one immutable canonical document type used for both:
  - rendering (`text` + `spans`)
  - resolution/planning (`paragraphs` + structural node index)
- Introduced `CanonicalDocument`.
- Removed `PlainDocument` and `DocumentModel`.
- Execution now updates canonical state without markdown reparse by rebuilding paragraphs/tree from canonical text+spans.

## Phase 6: Single Source Of Truth Execution State (In Progress)
- Remove dual execution state (`document` canonical + separate render text/spans) in apply loop.
- Keep one authoritative canonical state and derive render model only at API boundary.
- Delete render->canonical projection helpers in execute path.

## Phase 7: Paragraph-First Incremental Mutation (Planned)
- Apply accepted patches directly to canonical paragraphs where feasible.
- Rebuild structural hierarchy (`nodesById`, `rootNodeIds`, ranges) from paragraphs only.
- Keep markdown parse limited to initial entry build.

## Phase 8: Canonical Internal Operation Adapter (Planned)
- Add internal canonical operation type and adapter from current resolved operations.

## Phase 9: Cleanup
- Remove dead internal indirection and helpers introduced during migration.
