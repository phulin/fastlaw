# Plan: Separate Jurisdiction-Specific Logic in `container-rust`

## 1. Target Architecture

Create a clear split between:
- **Runtime layer (`runtime/*`)**: callback client, cache/R2 fetch, batching, progress reporting, and orchestration.
- **Source layer (`sources/*`)**: parser + mapping from source documents to `NodePayload`s.

### Proposed modules
- `src/runtime/callbacks.rs`
- `src/runtime/cache.rs`
- `src/runtime/orchestrator.rs`
- `src/runtime/types.rs`
- `src/sources/mod.rs`
- `src/sources/<jurisdiction>/mod.rs`
- `src/sources/<jurisdiction>/parser.rs` (migrated from current `parser.rs`)
- `src/sources/<jurisdiction>/adapter.rs` (jurisdiction-specific node shaping)

## 2. Clear Boundary: General vs Jurisdiction-Specific

### General (shared for all jurisdictions)
- HTTP server and `/ingest` request handling.
- Authenticated callback client (`unitStart`, `insertNodeBatch`, `progress`).
- Proxy cache/R2 fetch flow (`/api/proxy/cache`, `/api/proxy/r2-read`).
- Batch sizing/chunking and retry/error propagation policy.
- Ingest orchestration loop over units and progress state transitions.
- Common output envelope types used by runtime (`NodePayload`, `NodeMeta`, `SectionContent`).

### USC-specific (first jurisdiction implementation)
- USC XML parser and tag semantics.
- USC hierarchy logic (title/subtitle/chapter/.../section).
- USC-specific ID/path/readable-id/citation conventions.
- USC-specific section block extraction (`body`, `history_short`, `history_long`, `citations`).
- USC-specific cross-reference extraction rules.
- USC unit metadata shape (fields required to parse and map USC sources).

### Each new jurisdiction must provide
- `sources/<jurisdiction>/parser.rs`: parse raw source document to jurisdiction events/AST.
- `sources/<jurisdiction>/adapter.rs`: map parsed output to shared `NodePayload` format.
- Jurisdiction-specific parent resolution and string-id generation.
- Jurisdiction-specific path/readable-id/heading citation rules.
- Jurisdiction-specific content block mapping and optional metadata extraction.
- Jurisdiction-specific unit type and config decoding path.
- Golden fixture tests proving stable node output for that jurisdiction.

### Explicit ownership rule
- If code references callback endpoints, batching, or transport/auth concerns, it belongs in `runtime/*`.
- If code references document schema, legal hierarchy naming, citation format, or URL/path conventions, it belongs in `sources/<jurisdiction>/*`.

## 3. Define Shared Interface (Core Step)

Add a source plugin trait that runtime can call without source knowledge.

```ts
// Conceptual shape; implement in Rust
trait SourceAdapter {
  type Unit;

  fn source_key(&self) -> &'static str;
  async fn load_document(&self, runtime: &RuntimeCtx, unit: &Self::Unit) -> Result<Option<String>, String>;
  fn build_nodes(&self, unit: &Self::Unit, document: &str, ctx: &BuildCtx) -> Result<Vec<NodePayload>, String>;
}
```

Rust version should avoid over-abstraction but keep one strict seam:
- runtime owns fetch/post/progress loops.
- adapter owns parse/tree/content mapping.

## 4. Data Model Changes

Replace USC-specific ingest config with source-aware config.

### Current
- `IngestConfig { units: Vec<UnitEntry> }`
- `UnitEntry { unit: UscUnit, title_sort_order }`

### Target
- `IngestConfig { source: SourceKind, units: Vec<UnitEntry> }`
- `UnitEntry` holds generic fields plus source payload, e.g.:
  - `id`, `url`, `sort_order`, `external_id`, and optional `metadata` JSON.

If keeping strong typing is preferred:
- use enum variants:
  - `SourceKind::Jurisdiction`
  - `UnitEntry::Jurisdiction(JurisdictionUnit)`

## 5. Migration Phases

### Phase A: Pure moves (no behavior change)
1. Move callback/cache helpers from `ingest.rs` into `runtime` modules.
2. Move parser to `sources/jurisdiction/parser.rs`.
3. Rename `USC*` parser types to `Jurisdiction*` or neutral names local to source module.

### Phase B: Introduce adapter boundary
1. Create `JurisdictionAdapter` implementing source interface.
2. Move all parent resolution/path/id generation for jurisdiction-specific logic into `sources/jurisdiction/adapter.rs`.
3. Keep existing node output identical; verify with snapshot comparison.

### Phase C: Runtime orchestration generalization
1. Replace `ingest_usc` with `ingest_source` in runtime.
2. Dispatch adapter by `config.source`.
3. Update `main.rs` to call runtime entrypoint.

### Phase D: Cleanup and simplification
1. Delete old USC-named functions/types in shared modules.
2. Remove all source-specific constants from runtime.
3. Keep source-specific logic only under `src/sources/jurisdiction/*`.

## 6. File-by-File Change Plan

- `src/ingest.rs`
  - Shrink to orchestration glue or replace with `runtime/orchestrator.rs`.
  - Remove direct parser imports.
- `src/parser.rs`
  - Move to `src/sources/jurisdiction/parser.rs`; stop exporting in crate root.
- `src/types.rs`
  - Split into runtime config types and source unit types.
- `src/main.rs`
  - Depend on new generic ingest entrypoint.
- `src/lib.rs`
  - Export `runtime` and `sources`; avoid source type leakage in runtime APIs.

## 7. Validation Strategy

1. Build deterministic fixture tests for USC and each added jurisdiction.
2. Assert produced `NodePayload` list equality before vs after split.
3. Add integration test for `/ingest` with mock callback endpoints.
4. Run existing checks after each phase:
   - `yarn check:fix`
   - `yarn typecheck`

## 8. Cutover Rules

- No dual-path runtime beyond temporary migration branch.
- Keep external API stable only where required by current callers.
- Prefer deleting old USC-specific paths immediately after adapter parity is confirmed.

## 9. Risks and Mitigations

- Risk: ID/path regressions break downstream references.
  - Mitigation: snapshot golden test for `id`, `parent_id`, `path`, `heading_citation`.
- Risk: implicit parser assumptions lost during rename/move.
  - Mitigation: phase A is file move + rename only, no logic changes.
- Risk: config schema change impacts caller.
  - Mitigation: update caller in same PR; no long-term compatibility layer.
