# PDF Amendment Pipeline Refactor Plan

## Constraints
- Preserve runtime behavior and public API.
- Keep existing test suite unchanged.
- Ship in small, low-risk phases.

## Phase 1: Internal Module Decomposition (No Logic Changes)
- Split `packages/web/src/lib/amendment-edit-tree-apply.ts` into internal modules by concern:
  - `resolve/*`: path normalization and target resolution helpers.
  - `execute/*`: sequential execution helpers.
  - `summary/*`: failure reason mapping + apply summary shaping.
- Keep `applyAmendmentEditTreeToSection` exported from the original file as a facade.
- Move code only; do not alter branching or matching behavior.

## Phase 2: Planner Handler Split
- Split edit-kind handling in `amendment-edit-planner.ts` into per-kind modules.
- Keep `planOperationEdit` and `planEdits` signatures/behavior unchanged.

## Phase 3: Shared Patch/Attempt Utilities
- Deduplicate patch conflict and attempt-outcome bookkeeping.

## Phase 4: Rebuild Model Boundary
- Encapsulate resolution-model rebuild flow behind a single internal API.

## Phase 5: Canonical Document Unification (PlainDocument + DocumentModel)
- Replace dual model flow with one immutable canonical document type used for both:
  - rendering (`text` + `spans`)
  - resolution/planning (`paragraphs` + structural node index)
- Introduce `CanonicalDocument` and adapters from existing structures during migration.
- Make patch application return updated `CanonicalDocument` directly.
- Remove projection/rebuild helpers once migration is complete (e.g. render->canonical conversion helpers).
- Keep external behavior and public API unchanged while collapsing internal state.

## Phase 6: Canonical Internal Operation Adapter
- Add internal canonical operation type and adapter from current resolved operations.

## Phase 7: Cleanup
- Remove dead internal indirection and helpers introduced during migration.
