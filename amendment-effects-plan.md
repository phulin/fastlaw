# Amendment Effects Implementation Plan

## Scope
Implement precomputation of amendment effects per amendatory instruction and replace raw instruction text in PDF annotations with a styled amended statutory snippet.

## Proposed Architecture
1. `extractAmendatoryInstructions` (existing) yields target + operation tree.
2. New batch API resolves all needed section JSON bodies for all instructions in one request.
3. Client-side amendment-effect engine maps operation tree onto the fetched section body text.
4. UI renders `AmendedSnippet` from computed segments instead of raw instruction prose.

## Phase Plan

### Phase 2: Research and Data Contracts
1. Define request payload for batch route:
   - `sourceCode`
   - `sourceVersionId` (optional override; default latest)
   - `paths[]` of section paths (e.g. `/statutes/usc/section/7/2012`)
2. Define response payload:
   - `results[]` with:
     - `status` (`ok` | `not_found` | `error`)
     - `path`
     - `content` (raw section JSON body)
3. Lock TS types in a client amendment-effect module (new file path to choose during implementation):
   - `AmendmentEffect`
   - `AmendmentEffectSegment`
   - `AmendmentEffectStatus`

### Phase 3: Server-Side Batch Section-Body Fetch
1. Add DB helpers in `packages/web/src/lib/db.ts`:
   - batched node lookup by path/version (no descendant recursion).
2. Add new API route in `packages/web/src/worker.ts`:
   - `POST /api/statutes/section-bodies`
   - validates payload and returns `results[]` in request order.
   - dedupes repeated input paths internally for efficiency.
3. Keep response minimal and transport-oriented:
   - no server-side diff/effect computation,
   - no recursive hierarchy expansion.

### Phase 4: Client-Side Effect Computation and Rendering
1. Implement effect computation library in client code:
   - resolve target node from legacy root scope + tree context,
   - flatten relevant text region,
   - apply operation semantics (`replace`, `delete`, `insert_before`, `insert_after`, `add_at_end`),
   - emit structured inserted/deleted segments.
2. Keep deterministic behavior for unsupported operations:
   - mark as `unsupported`,
   - include fallback excerpt and reason.

### Phase 5: UI Rendering and Integration
1. Add `AmendedSnippet` component in `packages/web/src/components/AmendedSnippet.tsx`:
   - accepts `AmendmentEffect`,
   - renders semantic segments with classes:
     - inserted: highlighted,
     - deleted: strikethrough muted,
     - unchanged: normal.
2. Add styles in `packages/web/src/styles/pdf.css` for snippet block and diff tokens.
3. Integrate in `packages/web/src/PdfApp.tsx`:
   - after instruction extraction, call batch API once per document,
   - map each instruction to its section path client-side,
   - resolve `path -> section body` from API results,
   - compute instruction effect on client from full section body,
   - enrich annotation items.
4. Update `packages/web/src/components/AnnotationLayer.tsx`:
   - render `AmendedSnippet` for instruction entries,
   - fallback to raw instruction text if no effect.

### Phase 6: Tests and Validation
1. Unit tests for effect engine in `packages/web/src/lib/__tests__/amendment-effect.test.ts`:
   - replace, delete, insert_before, insert_after, add_at_end, nested target paths.
2. Route-level tests (or integration-like unit tests) for batch endpoint:
   - mixed found/missing requests,
   - ordering stability,
   - malformed payload handling.
3. UI tests for snippet rendering states:
   - normal diff render,
   - unsupported,
   - fallback raw text.
4. Run required checks:
   - `yarn check:fix`
   - `yarn typecheck`

## Risks and Mitigations
1. Target resolution mismatch between instruction hierarchy and statute node model.
   - Mitigation: keep trace metadata in response (`matchedPath`, `resolutionSteps`) for debugging.
2. Section-body fetch fanout could still be expensive for many instructions.
   - Mitigation: dedupe requested paths client-side and batch in one network call; server also dedupes defensively.
3. Complex amendment prose not representable as deterministic token edits.
   - Mitigation: explicit `unsupported` status with readable fallback.

## Clarifications Needed Before Implementation
1. Confirm exact endpoint name preference:
   - `POST /api/statutes/section-bodies` (proposed), or
   - another naming convention you prefer.
2. Confirm fallback UX for unsupported/unmatched instructions:
   - render raw instruction text, or
   - render explicit "snippet unavailable".
