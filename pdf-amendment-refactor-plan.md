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
- Phase 6 completed:
  - sequential execution state now keeps one live canonical source of truth.
  - render model is materialized at API boundary from patch batches.
  - canonical patch/update and render materialization flow extracted into dedicated module.
  - canonical runtime model dropped parse-only `sourceToPlainOffsets` state.
  - canonical runtime paragraphs dropped `startLine/endLine` (kept only where hierarchy parser requires synthetic values).
- Phase 7 completed:
  - paragraph-first mutation path is active for stable paragraph-shape edits.
  - complex edits still use deterministic paragraph reconstruction fallback.
- Phase 8 completed:
  - canonical planning-operation adapter introduced and wired through execute/planner boundary.
- Phase 9 completed:
  - removed obsolete state/fields and consolidated canonical-update helpers.

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

## Phase 6: Single Source Of Truth Execution State (Completed)
- Remove dual execution state (`document` canonical + separate render text/spans) in apply loop.
- Keep one authoritative canonical state and derive render model only at API boundary.
- Delete render->canonical projection helpers in execute path.

## Phase 7: Paragraph-First Incremental Mutation (Completed)
- Apply accepted patches directly to canonical paragraphs where feasible.
- Added a guarded fast path for inline (single-paragraph, no-newline) edits that updates paragraph records without full paragraph reconstruction.
- Expanded fast path to all stable paragraph-shape edits (same paragraph span count) using direct paragraph updates.
- Rebuild structural hierarchy (`nodesById`, `rootNodeIds`, ranges) from paragraphs only.
- Keep markdown parse limited to initial entry build.

## Phase 8: Canonical Internal Operation Adapter (Completed)
- Add internal canonical operation type and adapter from current resolved operations.

## Phase 9: Cleanup (Completed)
- Remove dead internal indirection and helpers introduced during migration.
