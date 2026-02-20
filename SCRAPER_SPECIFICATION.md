# Scraper Specification

You are implementing a new statute scraper in `packages/ingest` using the current ingestion architecture (Rust running in a container, callbacking batched nodes into the Worker).

The goal is simple: produce a clean hierarchy of nodes plus per-section content blocks, with deterministic IDs and ordering, and enough tests to prove extraction quality.

DO NOT return success without a fully compliant scraper. Keep iterating until all requirements in this document are met.

## 0. New Jurisdiction Implementation Playbook

When adding a scraper for a new jurisdiction, first copy this checklist VERBATIM into your `task_plan.md` file.

- [ ] Create a specification for the input: how do we access the data? what format is it in? how do we extract hierarchy, node names, and node content?
- [ ] Write tests for the full specification. Tests should cover:
- - [ ] Extraction of all relevant information from an HTML file for all structural levels and for section bodies.
- - [ ] Bolding of section markers (plus any other information bolded in the source).
- - [ ] Cross-reference linking - and the link href should be in the same format as the sections, i.e. the links should work.
- - [ ] Capture of history and notes.
- - [ ] Reserved/transferred/repealed behaviors (if source has them).
- - [ ] Find the UCC and an interstate compact or two, which often have different formats. Confirm those parse correctly (at the structural and section level).
- - [ ] An integration test with mocked HTTP responses that confirms that the full pipeline extracts correctly.
- - [ ] A baseline test that compares concatenated parser output to a simple extract-all-text-content baseline.
- [ ] Write the scraper. Make sure it:
- - [ ] If possible, uses information from the source to create a source version that identifies this version of the source.
- - [ ] Produces a clean hierarchy of nodes plus per-section content blocks, with deterministic IDs and ordering, and enough tests to prove extraction quality.
- - [ ] Includes all information from the source e.g. any history or citation notes.
- - [ ] Inserts nodes in batches from container to Worker. This is important!
- - [ ] Emits blobs and nodes as we parse the nodes, and doesn't accumulate them in memory.
- [ ] Iterate until all required tests and quality checks pass.

### 0.1 Build order

1. Start from the closest existing adapter under `packages/ingest/container-rust/src/sources/`.
2. Reuse node/content conventions from this document.
3. Keep IDs, level naming, block types, and cross-reference metadata consistent with existing scrapers unless source requirements force a clear deviation.

### 0.2 Execution constraints

- Keep memory bounded by unit:
  - use streaming/event-driven parsers over full DOM transforms
  - avoid retaining the full crawl/version in RAM
  - it is OK to hold one entire unit (for example one title XML) in memory
  - target deployment is a container with **1 GB RAM**; size parsing strategy for that budget
- Keep callback and persistence throughput stable:
  - emit nodes in batches from container to Worker. this is important!
  - avoid one-callback-per-node behavior. DO NOT insert nodes one-by-one!
  - current baseline batch size is `BATCH_SIZE = 200` in `packages/ingest/container-rust/src/runtime/orchestrator.rs`
  - tune batch size only with measured memory/latency/throughput data
- Keep ingest progress deterministic:
  - discovery should be cheap and deterministic
  - unit processing should produce stable node IDs and ordering
  - retries should be idempotent at the Worker insertion layer

### 0.3 Test and validation bar before success

A new scraper is not complete until all of the following pass:

1. Unit/integration tests for parser behavior and edge cases.
2. A full-title (or equivalently medium-size unit) text-content baseline test:
   - compare concatenated parser output to a simple extract-all-text-content baseline
   - baseline should skip only navigational/labeling text
3. Manual spot checks on sampled sections:
   - at least five ordinary sections
   - at least five of each complex/edge type (for example repealed/reserved/transferred/table-heavy)
   - verify heading, body, note/amendment/citation routing, and path/ID correctness
4. Runtime sanity checks:
   - callback batching is happening (multiple `insertNodeBatch` callbacks)
   - no unbounded memory growth over a medium-size unit
5. Workflow integration tests:
   - create a mock insertNodeBatch callback
   - create fixtures representing a set of nodes
   - check the nodes resulting from this callback

### 0.4 Politeness rules

- Limit scraping to 10 requests/second unless source policy requires stricter behavior.
- First, try to find a bulk data download. If not available, use an API. If neither exists, scrape official-source pages.

Do not report success until all checks above pass.

## 1. Scope and Architecture

### 1.1 Pipeline shape

All containerized scrapers follow the same shape:

1. Worker starts ingest (`/api/ingest/<source>`) and provides callback credentials.
2. Container performs source discovery.
3. Container calls `/api/callback/ensureSourceVersion` with version/root/unit discovery output.
4. Container processes each unit and emits node batches via `/api/callback/insertNodeBatch`.
5. Worker inserts nodes, stores content blobs, updates ingest job state.

Relevant files:

- Worker orchestration: `packages/ingest/src/worker.ts`
- Container service binding: `packages/ingest/src/lib/ingest-container.ts`
- Rust orchestrator: `packages/ingest/container-rust/src/runtime/orchestrator.rs`
- Runtime callbacks: `packages/ingest/container-rust/src/runtime/callbacks.rs`

### 1.2 Why this split exists

- Container handles source-specific parsing and extraction where CPU-heavy work belongs.
- Worker handles durable persistence (D1 + packfiles) and job lifecycle bookkeeping.
- Batch callbacks decouple parser throughput from storage throughput.

## 2. Required Contract

Implement `SourceAdapter` in Rust (`packages/ingest/container-rust/src/sources/mod.rs`).

### 2.1 Required fields/methods

- `discover(client, download_base) -> DiscoveryResult`
- `process_unit(unit, context, xml) -> Result<(), String>`
- `unit_label(unit) -> String`

### 2.2 Data structures you produce

Core types live in `packages/ingest/container-rust/src/types.rs`.

- `DiscoveryResult`
- `root_node` (`NodeMeta`)
- `unit_roots` (list of top-level ingest units)
- `NodePayload`
  - `meta` (`NodeMeta`)
  - `content` (`None` for structural nodes, object for sections)
- section content JSON (`SectionContent` with `blocks` and optional `metadata`)

`IngestContext` in `packages/ingest/container-rust/src/runtime/types.rs` provides:

- `nodes.insert_node(...)`
- `nodes.flush()`
- `blobs.store_blob(...)` abstraction

Adapters must emit through these interfaces; do not bypass them with direct callback calls.

## 3. Node and ID Model

`NodeMeta` is persisted directly by the Worker.

### 3.1 ID rules

- `id` is canonical; do not create a separate opaque ID layer.
- IDs must be deterministic across runs for unchanged source content.
- Parent IDs must resolve to deterministic node IDs in the same source version.

### 3.2 Recommended patterns

- Root/version-scoped IDs should include source/version identity.
- Intermediate levels should encode normalized hierarchy designators.
- Section IDs should be derived from normalized section keys under deterministic parents.

USC-style examples in the current adapter:

- title root under `{root_string_id}/t{title}/root`
- section paths like `/statutes/usc/section/{title}/{section}`

### 3.3 Level and sort semantics

- `level_index` must be stable and meaningful for that source.
- `sort_order` must provide deterministic sibling ordering.
- For alphanumeric designators, normalize and sort deterministically.

## 4. Source Discovery and Versioning

### 4.1 Discovery responsibilities

Discovery should:

- fetch source index/root metadata
- compute source-native `version_id`
- build `root_node` with stable root metadata
- discover unit roots (for example title files/pages)

Container must then call Worker callback `ensureSourceVersion` exactly once per run.

### 4.2 Version meaning

Version should represent the source snapshot identity, not ingestion runtime timestamp.

- USC uses release metadata from the official distribution
- other sources should use native revision/version markers where available

## 5. Unit Processing

### 5.1 `process_unit` responsibilities

For each unit:

- parse unit source
- emit all structural nodes
- emit section nodes with content blocks
- dedupe duplicates by deterministic IDs/keys
- flush remaining buffered nodes at unit end

### 5.2 Practical guidance

- parse once for structure and section content when feasible
- keep section identity minimal and deterministic:
  - section number/designator
  - normalized slug/key
  - source URL/local identifier when required
- dedupe early with `HashSet`/maps keyed by final deterministic IDs

### 5.3 Parent resolution

Resolve parent IDs during unit processing.

USC current pattern:

- levels use parsed identifier/parent_identifier relationships
- sections resolve parent from parsed `USCParentRef` (title-level or level-level)

## 6. Batch Emission and Content Assembly

### 6.1 Node batch emission responsibilities

Container runtime `NodeStore` must:

- buffer nodes
- send batches to Worker via `/api/callback/insertNodeBatch`
- flush at end-of-unit

Requirements:

- structural nodes emit `content: null`/`None`
- section nodes emit normalized content object
- batch size should avoid callback overhead explosions and memory spikes

### 6.2 Content format

Use block-based section content JSON:

```ts
{
  blocks: [
    { type: "body", content: string },
    { type: "source_credit", label: "Source Credit", content: string },
    { type: "amendments", label: "Amendments", content: string },
    { type: "note", label: "Notes", content: string }
  ],
  metadata?: {
    cross_references: SectionCrossReference[]
  }
}
```

Only include optional blocks when non-empty.

### 6.3 Cross-references

Extract cross-references from body plus relevant note/citation-like blocks.

For USC, current adapter behavior uses body + notes text as input to cross-reference extraction.

## 7. Parsing Guidelines

### 7.1 Parse directly to normalized output

Do not keep large intermediate DOM/tree structures when avoidable.

Current USC parser (`packages/ingest/container-rust/src/sources/usc/parser.rs`) is the model:

- event-driven streaming parse
- emits title/level/section events
- adapter consumes and writes nodes incrementally

### 7.2 URL normalization and crawl boundaries

For HTML crawlers, implement strict URL normalization/filtering:

- reject `mailto:` and `javascript:`
- resolve relative URLs
- enforce allowed domain
- enforce allowed path prefix
- normalize case where source paths are case-insensitive
- strip fragments

### 7.3 Text extraction

Expected behavior:

- capture real statutory text
- skip pure navigation/label wrappers
- preserve meaningful structure with newlines
- collapse excess whitespace
- trim accidental trailing noise

### 7.4 Parser performance lessons (from current USC parser)

Use these patterns in hot paths:

- compact tag classification with bitmask checks
- avoid repeated attribute decoding (cache decoded attrs per event)
- keep parser state flat (stacks + small structs), not object-heavy trees
- normalize and append text with minimal allocation churn
- dedupe path/key collisions deterministically during parse

## 8. Testing Specification

Testing should prove correctness with simple, robust checks first.

### 8.1 Required fixture strategy

For each new scraper, include fixtures for at least:

- one medium-size unit (typically a title)
- reserved/transferred/repealed behaviors (if source has them)
- one formatting-heavy case (tables, unusual nesting, or annotations)

### 8.2 Required core tests

- designator normalization + sorting
- URL normalization/filtering
- hierarchy extraction (levels + parent linkage)
- section extraction (IDs, names, paths, order)
- content block routing
- at least one cross-reference extraction assertion
- batch callback behavior (aggregated callbacks, not per-node)

### 8.3 Baseline text-comparison test (required)

Use one medium-size unit and compare parser output to a deliberately simple baseline extractor.

The baseline extractor should:

- walk all text content in each section container in source order
- skip only obvious navigational/labeling content
  - navigation tables/menus
  - section labels already represented structurally (for example heading/number wrappers)
- normalize whitespace aggressively
- produce one concatenated string per section

Then compare, per section:

- `parserConcatenated` = heading + body + relevant notes/citations (normalized)
- `baselineConcatenated` = simple extractor output (normalized)

Assert near-equality with whitespace-insensitive comparison.

### 8.4 Failure diagnostics

When mismatch occurs, print:

- section ID
- first mismatch index
- short context windows from expected and actual

Keep diagnostics terse so fixture updates remain maintainable.

## 9. Implementation Checklist

1. Define source kinds, unit payload shape, and adapter module.
2. Implement `discover` with version + root node + unit roots.
3. Implement `process_unit` to emit structural and section nodes.
4. Ensure node emission is buffered and flushed in batches! DO NOT insert nodes one-by-one!
5. Add URL normalization and parsing helpers.
6. Add deterministic designator normalization/sort helpers.
7. Add or adapt cross-reference extraction for the source citation grammar.
8. Add fixtures and tests including the simple baseline text-comparison test.
9. Wire Worker ingest endpoint and callback flow for the new source.
10. Validate end-to-end ingest with real sample units.

## 10. References in This Codebase

- Worker ingest/callback endpoints: `packages/ingest/src/worker.ts`
- Container binding: `packages/ingest/src/lib/ingest-container.ts`
- Packfile persistence DO: `packages/ingest/src/lib/packfile-do.ts`
- Rust orchestrator: `packages/ingest/container-rust/src/runtime/orchestrator.rs`
- Runtime callbacks: `packages/ingest/container-rust/src/runtime/callbacks.rs`
- Runtime interfaces/types: `packages/ingest/container-rust/src/runtime/types.rs`, `packages/ingest/container-rust/src/types.rs`
- Source adapter trait/registry: `packages/ingest/container-rust/src/sources/mod.rs`
- USC adapter/parser: `packages/ingest/container-rust/src/sources/usc/adapter.rs`, `packages/ingest/container-rust/src/sources/usc/parser.rs`
- Parser benchmark harness: `packages/ingest/container-rust/src/bench_parser.rs`
