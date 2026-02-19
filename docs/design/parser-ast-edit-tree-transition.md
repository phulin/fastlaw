# Parser/AST/Edit-Tree Pipeline Transition Design

## Summary

This document defines the end-state and migration plan for moving PDF amendment processing to a parser-first pipeline:

`paragraphs -> parsed instruction -> instruction AST -> semantic edit tree -> applied amendment effect`

The transition removes behavioral dependency on:

- `packages/web/src/lib/amendatory-instructions.ts`
- `packages/web/src/lib/amendment-effects.ts`

for instruction targeting/scope derivation in the new path.

## Goals

1. Use parser output as the sole source of targeting metadata in the new pipeline.
2. Ensure `InstructionSemanticTree.targetScopePath` always includes:
   - a top-level code/act reference segment
   - a top-level section segment
3. Prefer USC-derived targeting when USC is present in the parsed instruction.
4. Apply edits using semantic tree metadata only (no legacy root scope fallback from legacy extraction).
5. Preserve debuggability with explicit parse/translation/apply failure reasons.

## Non-Goals

1. Perfect parse coverage for all legislative prose on day one.
2. Backward-compatible behavior for unsupported or ambiguous patterns.
3. Maintaining legacy extraction heuristics once parser path is complete.

## Current State (As Of This Change)

1. Edit-tree root now carries `targetScopePath` with mixed segment types:
   - `code_reference`
   - `act_reference`
   - structural scope kinds (`section`, `subsection`, etc.)
2. Translator derives `targetScopePath` from AST and prefers USC scope when available.
3. Apply engine uses `tree.targetScopePath` for root scope, not legacy root scope.
4. `PdfApp` no longer passes `instruction root scope` into apply.

## End-State Architecture

## 1) Instruction Discovery

Input: ordered extracted paragraphs.

Algorithm:

1. Start at paragraph index `i`.
2. Attempt parser from beginning of paragraph text (`parseOffset === 0` only).
3. Parser consumes as many subsequent lines/paragraph content as matched.
4. If parse succeeds, emit one parsed instruction span and advance to first unconsumed paragraph.
5. If parse fails, treat paragraph as non-instruction annotation content.

Important invariant:

- A paragraph can belong to at most one instruction span.

## 2) Parsing

Output: `ParsedInstruction`.

Required fields:

- `startIndex`, `endIndex`, `text`
- `ast` (`InstructionAst`)
- exact consumed range information for deterministic span mapping

Hard requirement:

- No mid-line parse anchoring in production path.

## 3) AST -> Semantic Tree Translation

Output: `InstructionSemanticTree`.

Required root metadata:

- `targetScopePath`:
  - segment 0: `code_reference` or `act_reference`
  - at least one `section` segment somewhere after segment 0

Extraction precedence:

1. USC ref in parsed parent/codification:
   - derive code reference from USC title
   - derive structural path from USC section/subsections
2. Fallback (no USC):
   - derive top-level context from underlying code/act phrase
   - derive structural path from initial locator (`Section ...`, `Subsection ...`)

Failure policy:

- If translator cannot produce both top-level context + section, emit translation issue and mark instruction unsupported for apply.

## 4) Edit Application

Input:

- `InstructionSemanticTree`
- target section body text

Scope resolution:

1. Root scope comes from structural segments in `targetScopePath`.
2. Non-structural top-level segments (`code_reference`, `act_reference`) are metadata only.
3. Operation-level targets/restrictions further narrow scope.

No legacy scope input:

- Do not accept or use legacy root scope in the parser-native path.

## 5) Rendering / Annotation

Instruction annotations should render from parser-native objects:

- parsed instruction text
- parsed citation/context extracted from AST/tree
- apply result (`ok`/`unsupported`, patches, debug attempts)

No dependency on legacy instruction object shape in UI-facing contracts.

## Data Model Plan

## Keep

1. `InstructionSemanticTree`
2. `UltimateEdit` and tree child node types
3. Apply result model (`AmendmentEffect` or successor)

## Add / Normalize

1. Parser-native instruction envelope type (new):
   - source span
   - parsed AST
   - translated tree
   - target section path resolution
   - apply status/debug
2. `targetScopePath` schema as stable API contract.
3. Optional tree-level `targetCitation` (recommended):
   - canonical USC citation string when present
   - helps direct section-path resolution without separate citation parser pass

## Remove (after migration)

1. `extractAmendatoryInstructions` usage in `PdfApp` parser-native path.
2. Legacy-targeting helper usage in parser-native path:
   - citation extraction from raw prose
   - legacy legacy root scope derivation
3. Legacy-only tests that no longer map to parser-first semantics.

## Section Path Resolution Strategy

Preferred:

1. Resolve from tree-level USC metadata (`targetCitation` and/or USC `targetScopePath`).
2. Build canonical path `/statutes/usc/section/{title}/{section}`.

Fallback:

1. If no USC context, instruction is target-unresolved for USC fetch.
2. Keep annotation visible with explicit unsupported reason.

Design rule:

- Do not infer USC section from act-local section numbers unless parser provides explicit codification.

## Unsupported/Partial Handling

Supported statuses should remain explicit:

1. `ok` when at least one patch applies.
2. `unsupported` when parsing, translation, scope resolution, or patch matching fails.

Required debug fields:

1. parser status and consumed span
2. translation issues
3. apply operation attempts
4. normalized failure reason enum/string

## Migration Plan

## Phase 1: Dual Pipeline Instrumentation

1. Introduce parser-native instruction envelope and keep legacy path in parallel.
2. Run both pipelines on same documents.
3. Compare:
   - instruction count
   - target section path
   - apply status
   - patch outputs
4. Log divergence with reproducible fixture snippets.

Exit criteria:

- Known divergence bucketed and triaged.

## Phase 2: Parser-First Read Path

1. Render annotations from parser-native envelope by default.
2. Keep legacy path as shadow mode for telemetry/comparison only.
3. Remove legacy root scope plumb-through from app-level callsites.

Exit criteria:

- Parser-native pipeline stable on representative corpora.

## Phase 3: Legacy Targeting Removal

1. Delete dependency on legacy instruction extraction in active path.
2. Delete legacy-targeting fallbacks from apply path.
3. Remove unused legacy tests and fixtures.

Exit criteria:

- No runtime imports from legacy modules in parser-native flow.

## Testing Strategy

## Unit

1. Parser span consumption tests:
   - strict `parseOffset === 0`
   - multi-paragraph consumption boundaries
2. AST->tree target extraction tests:
   - USC preferred over act-local section
   - top-level context + section invariant
3. Apply tests:
   - root scope from `targetScopePath` only
   - no scope => unsupported

## Integration

1. End-to-end paragraph fixtures -> annotation/apply output snapshots.
2. Regression corpus from real bill sections.
3. Golden tests for known hard patterns:
   - redesignations
   - nested subinstructions
   - sentence-level location anchors

## Operational / UX Considerations

1. Unsupported instructions should remain visible in UI with actionable diagnostics.
2. Modal debug views should show parser-native metadata first.
3. Avoid silent fallback to legacy-derived scope.
4. Keep deterministic ordering and color assignment stable across reloads.

## Risks

1. Grammar coverage gaps reduce instruction detection compared to heuristic extraction.
2. USC codification patterns may vary enough to require grammar expansion.
3. Strict scope invariants can increase unsupported rate initially.
4. Dual-path period may increase complexity and maintenance overhead.

## Mitigations

1. Add focused grammar fixtures before broad rollout.
2. Track unsupported reasons and prioritize by frequency.
3. Keep parser/translator/apply contracts minimal and explicit.
4. Gate cutover with measurable corpus pass thresholds.

## Open Decisions

1. Whether to add explicit `targetCitation` to `InstructionSemanticTree`.
2. Whether to remove `targetSection` after all apply callers consume `targetScopePath`.
3. Whether to hard-fail translation when top-level context + section invariant is not met, versus soft unsupported.

## Acceptance Criteria For Full Transition

1. Active PDF amendment pipeline uses only parser/AST/edit-tree targeting metadata.
2. No active-path dependency on `amendatory-instructions`/`amendment-effects` targeting helpers.
3. `targetScopePath` invariant holds for all instructions that proceed to apply.
4. Unsupported states are explicit, observable, and test-covered.
