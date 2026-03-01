# PDF Amendment Edit Pipeline Review

## Executive Summary
The current pipeline works, but complexity is concentrated in a few very large modules and in repeated cross-stage fallback logic. The architecture has effectively become a mini compiler + interpreter + formatter in one path, with weak boundaries between phases.

The biggest simplification opportunity is to split responsibilities by stage and remove fallback-heavy behavior from the core apply path. A parser-first, deterministic operation model would let us cut substantial code while improving debuggability and correctness.

## Current Architecture

### End-to-End Flow
1. UI (`PdfApp.tsx`) loads PDF and starts worker.
2. Worker (`processing.worker.ts`) extracts paragraphs and page layouts.
3. Instruction discovery (`instruction-utils.ts`) finds parsed instruction spans.
4. AST translation (`amendment-ast-to-edit-tree.ts`) builds semantic edit trees.
5. Section resolution (`page-items.ts`) maps target scope to USC section paths and fetches bodies.
6. Apply engine (`amendment-edit-tree-apply.ts` + planner + transaction) resolves targets, plans patches, applies patches, and builds debug summaries.
7. Rendering uses amended render model/spans (`amended-snippet-render.tsx`).

### Core Module Weight (LOC)
- `amendment-edit-planner.ts`: 1850
- `amendment-edit-tree-apply.ts`: 1737
- `amendment-ast-to-edit-tree.ts`: 1551
- `amendment-edit-apply-transaction.ts`: 492
- `amendment-document-model.ts`: 596
- plus worker/page-items/instruction utils
- total sampled core: 6912 LOC

## Complexity Diagnosis

### 1) Stage Boundaries Are Blurry
`amendment-edit-tree-apply.ts` does tree walk, path resolution, operation creation, sequential execution, patch conflict behavior, redesignation bookkeeping, summary generation, and debug payload assembly.

### 2) Planner Is Overloaded
`planPatchForOperation` in `amendment-edit-planner.ts` contains a large switch over edit kinds plus multiple fallback match strategies, formatting rules, and range/anchor/sentence/location targeting behaviors.

### 3) Duplicate Semantics Across Modules
Conflict filtering, outcome accounting, patch ordering, and operation-attempt tracking appear in multiple places (`planEdits`, `executeResolvedOperationsSnapshot`, sequential apply paths).

### 4) Expensive Rebuild Loop
The sequential executor repeatedly reapplies patches and rebuilds canonical models to keep offsets/path resolution coherent. This is robust but costly in conceptual and implementation complexity.

### 5) Formatting and Semantics Are Coupled
Patch application (`amendment-edit-apply-transaction.ts`) combines text insertion semantics with sophisticated spacing and span-containment normalization. This makes the semantic layer harder to reason about.

### 6) Fallback Stack Is Too Deep
Search and resolution fallback layers (exact, translated, normalized, regex wildcard, structural references) increase behavior surface and make failures difficult to predict.

## Simplification Proposals

## Proposal A (Recommended): Deterministic 3-Stage Compiler Pipeline
### Shape
1. **Translate**: AST -> canonical `EditOperation[]` (no patch logic).
2. **Resolve**: operations + immutable document index -> concrete ranges/anchors.
3. **Apply**: pure patch execution engine over plain text; optional separate formatter pass.

### Rules
- One module per stage.
- One canonical operation shape (eliminate many optional fields).
- No planner-owned fallback search. Either resolve target deterministically or fail with reason.
- Separate renderer spans from core semantic apply result.

### Expected Impact
- Largest code reduction potential.
- Clear failure modes.
- Better testability (goldens per stage).

## Proposal B: Collapse Planner + Apply Into Single Operation Executor
### Shape
- Remove `planEdits` and per-operation tentative patch planning as a separate abstraction.
- For each resolved op, execute directly to a transactional text model with strict conflict policy.
- Keep one attempt record emitted by executor only.

### Expected Impact
- Medium/high reduction with less migration risk than Proposal A.
- Fewer duplicate code paths and state transitions.

## Proposal C: Strict Mode + Compatibility Adapter
### Shape
- Introduce strict pipeline for 80-90% known patterns.
- Move fallback heuristics into an explicit optional adapter layer.
- Default production path uses strict mode; fallback runs only when opted in/debug.

### Expected Impact
- Dramatically reduces core branching while preserving legacy rescue behavior behind a gate.

## High-Leverage Refactors (Short-Term)
1. Extract `ResolutionEngine` from `amendment-edit-tree-apply.ts` (tree walk + path resolve only).
2. Extract `OperationExecutor` from `amendment-edit-planner.ts` (edit-kind switch only).
3. Centralize attempt/outcome/conflict accounting in one utility.
4. Move apply-summary/debug packaging into a post-processing module.
5. Make classification override translation a dedicated pre-resolution pass.

## Suggested Target Data Model
- `CanonicalInstruction`
  - `instructionId`
  - `targetScopePath`
  - `operations: CanonicalOperation[]`
- `ResolvedOperation`
  - canonical op + `resolvedRange|resolvedAnchor`
- `ApplyResult`
  - `text`
  - `diff` (insert/delete ranges)
  - `failures` (typed)
- `RenderResult`
  - derived spans/snippet only (not used by resolver)

## Migration Plan
1. Add a new strict `CanonicalOperation` path in parallel with existing flow.
2. Route parser-first instructions through strict path first; fall back only when unsupported.
3. Remove duplicated attempt/conflict accounting from old modules.
4. Delete legacy fallback behaviors that strict path supersedes.
5. Make strict path default; keep fallback only in diagnostics mode.

## Risks and Controls
- Risk: unsupported rate spikes initially.
  - Control: dual-run harness (`run-pdf-pipeline-failures.ts`) with corpus diffing.
- Risk: behavior regressions for edge legislative prose.
  - Control: golden tests per stage and explicit unsupported reasons.

## Bottom Line
The current pipeline’s main problem is not any single bug; it is that resolution, planning, execution, and rendering concerns are interleaved across large files. The cleanest way to dramatically simplify is a strict staged architecture with a canonical operation model and a thin optional fallback adapter.
