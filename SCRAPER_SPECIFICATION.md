# Scraper Specification

This document defines how to implement a new statute scraper in `packages/ingest` using the existing generic ingestion workflow.

The goal is simple: produce a clean hierarchy of nodes plus per-section content blocks, with deterministic IDs and ordering, and enough tests to prove extraction quality.

DO NOT return success without a fully compliant scraper. Keep iterating on your own until you have met all requirements in this document.

## 0. New Jurisdiction Implementation Playbook

When adding a scraper for a new jurisdiction, follow this sequence:

1. Mirror existing patterns first.
2. Keep parsing and workflow steps bounded for Cloudflare runtime constraints.
3. Build comprehensive edge-case tests early.
4. Iterate until all required tests and quality checks pass.

### 0.1 Build order

1. Start from the closest existing adapter (`usc` for XML-heavy sources, `cga` for HTML-heavy sources).
2. Reuse the same generic workflow contract and node/content conventions from this document.
3. Keep IDs, level naming, block types, and cross-reference metadata consistent with existing scrapers unless the source requires a clear deviation.

### 0.2 Cloudflare execution constraints

- Keep memory bounded:
  - you MUST use streaming parsers over full-document in-memory transforms 
  - avoid retaining full crawls in RAM (cache any necessary information in R2)
  - parse once for planning and only re-parse where required for shard loading
  - only pass information between workers via the workflows data model
  - the orchestrating worker must keep only the plan in memory
  - CF workers has a hard memory limit of 128 MB. This is very tight and you will have to stick to it strictly. Estimate usage based on the largest unit you process to ensure we stay under the limit.
- Keep workflow step counts bounded (hard limit of 500 steps):
  - batch shard work items
  - avoid unnecessary per-section `step.do` fan-out
  - keep `discoverRoot` and `planUnit` deterministic and compact
  - limit concurrency to ~5 units at a time (use `promiseAllWithConcurrency`)
- If details are unclear, check Cloudflare docs and tune batch sizes and parsing strategy accordingly.

### 0.3 Test and validation bar before success

A new scraper is not complete until all of the following pass:

1. Unit/integration tests for parser behavior and edge cases.
2. A full-title (or equivalently medium-size unit) text-content baseline test:
   - compare concatenated parser output to a simple extract-all-text-content baseline
   - baseline should skip only navigational/labeling text
3. Manual spot checks on a few sampled sections:
   - include at least five ordinary sections
   - include at least five of each type of complex/edge section (for example repealed/reserved/transferred/table-heavy)
   - verify heading, body, history/citations routing, and path/ID correctness

### 0.4 Politeness rules

- Limit scraping to 10 requests/second.
- First, try to find a bulk data download. If you can't find bulk data, try to find an API. If you can't do that, scrape any official-source HTML you can find.

Do not report success until all checks above pass.

## 1. Scope and Architecture

### 1.1 Pipeline shape

All scrapers plug into the same 3-phase generic workflow (`packages/ingest/src/lib/workflows/generic/runner.ts`):

1. `discoverRoot`
2. `planUnit`
3. `loadShardItems`

The runner handles source/version records, blob storage writes, and batched node inserts. The scraper adapter provides source-specific discovery and parsing.

### 1.2 Why this split exists

- `discoverRoot` should be cheap and define the version + root + unit roots.
- `planUnit` should define full hierarchy and all section shard work items for one unit.
- `loadShardItems` should materialize final node content for shard items.

This allows large ingests without loading all content at once.

## 2. Required Contract

Implement `GenericWorkflowAdapter<TUnit, TShardMeta>` (`packages/ingest/src/lib/workflows/generic/types.ts`).

### 2.1 Required fields

- `source`: `{ code, name, jurisdiction, region, docType }`
- `discoverRoot({ env, force }) => RootPlan<TUnit>`
- `planUnit({ env, root, unit }) => UnitPlan<TShardMeta>`
- `loadShardItems({ env, root, unit, sourceId, sourceVersionId, items }) => ShardItem[]`

### 2.2 Data structures you produce

- `RootPlan`
- `rootNode` (`NodeMeta`)
- `unitRoots` (list of top-level crawl units)
- `UnitPlan`
- `shardItems` containing either:
  - prebuilt structural node metadata (`kind: "node"`)
  - section content work (`kind: "section"`)
- `ShardItem`
  - `node` (`NodeMeta`)
  - `content` (`null` for structural nodes, object for sections)

## 3. Node and ID Model

`NodeMeta` is defined in `packages/ingest/src/types.ts` and persisted directly.

### 3.1 ID rules

- `id` is the canonical string ID; do not create a separate opaque ID.
- IDs must be deterministic across runs for unchanged source content.
- Parent IDs must resolve to another deterministic node ID in the same source version.

### 3.2 Recommended patterns (from existing scrapers)

- Root: `{source_code}/{version}/root`
- Intermediate levels: append `/title-{id}`, `/chapter-{id}`, `/article-{id}`, etc.
- Section: append `/section-{slug}`

Examples:

- USC: `usc/119-73not60/root/title-42/chapter-21/section-1983`
- CGA: `cgs/2025/root/title-42a/article-2a/section-42a-2a-404`

### 3.3 Level and sort semantics

- `level_index` must be stable and meaningful for that source.
- `sort_order` must provide deterministic sibling ordering.
- For alphanumeric designators, normalize for sorting (see CGA `designatorSortOrder`).

## 4. Source Discovery and Versioning

### 4.1 `discoverRoot` responsibilities

- Fetch the source index/root page.
- Compute `versionId` (date for USC, revision year for CGA).
- Build `rootNode` with:
  - `level_name: "root"`
  - `level_index: -1`
  - `path`, `readable_id`, `heading_citation` for root landing page.
- Discover unit roots (usually title pages/files).

### 4.2 Version meaning

Version should represent the source snapshot identity, not ingestion runtime.

- USC currently uses the "release point" from the House statute revisors.
- CGA uses extracted "revised to" year from page content.

For a new scraper, prefer source-native revision/version metadata when available.

## 5. Unit Planning

### 5.1 `planUnit` responsibilities

For each unit:

- Build all structural nodes for that unit.
- Build section shard items keyed by enough metadata to re-find the section in `loadShardItems`.
- Do not write blobs here.

### 5.2 Practical guidance

- Parse once for structure/indexing.
- Keep section identity minimal and deterministic:
  - section number
  - normalized slug
  - source URL + local identifier if needed
- Dedupe duplicates early with a `Set` keyed by final node ID.

### 5.3 Parent resolution

Resolve parent IDs at planning time.

Patterns in current code:

- USC levels infer parent from `identifier`/`parentIdentifier` relationships.
- USC sections derive parent from parsed `parentLevelId`.
- CGA sections attach to chapter/article nodes directly.

## 6. Shard Loading and Content Assembly

### 6.1 `loadShardItems` responsibilities

- Return all nodes for the shard batch.
- For `kind: "node"`: return `content: null`.
- For sections: parse/extract text blocks and return content object.

### 6.2 Content format

Use block-based content JSON:

```ts
{
  blocks: [
    { type: "body", content: string },
    { type: "history_short", label: "Short History", content: string },
    { type: "history_long", label: "Long History", content: string },
    { type: "citations", label: "Citations" | "Notes", content: string }
  ],
  metadata?: {
    cross_references: SectionCrossReference[]
  }
}
```

Only include optional blocks when non-empty.

### 6.3 Cross-references

Extract cross-references from body plus citation-like blocks where useful.

- USC: `extractSectionCrossReferences([body, citations].join("\n"), titleNum)`
- CGA: `extractSectionCrossReferences([body, seeAlso].join("\n"))`

## 7. Parsing Guidelines

### 7.1 Parse directly to normalized output

Do not keep huge intermediate raw DOM structures when avoidable.

- USC: SAX-style XML stream parser emits title/level/section events.
- CGA: HTML parser extracts TOC + body in one pass with parser state.

### 7.2 URL normalization and crawl boundaries

Implement strict URL normalization/filtering for HTML crawlers:

- reject `mailto:` and `javascript:`
- resolve relative URLs
- enforce allowed domain
- enforce allowed path prefix
- normalize path case when source is case-insensitive
- strip fragments

### 7.3 Text extraction

Expected behavior:

- capture real statutory text
- skip pure navigation and labeling wrappers
- preserve meaningful structure with newlines
- collapse excess whitespace
- trim noisy trailing headings accidentally included in section body

### 7.4 Content blocks

For class-based HTML sources, name the default (section content) block "body" and name any other block an identifier based on its name in the source material.

- default -> `body`
- History -> `history`
- Citations -> `citations`
- Amendments -> `amendments`

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

This test is intentionally simpler than the current USC helper in `packages/ingest/src/__tests__/usc-parser.test.ts`; do not replicate complex token-level spacing heuristics unless a source absolutely requires it.

### 8.4 Failure diagnostics

When mismatch occurs, print:

- section ID
- first mismatch index
- short context windows from expected and actual

Keep diagnostics terse so fixture updates remain maintainable.

## 9. Implementation Checklist

1. Define adapter types (`TUnit`, `TShardMeta`) and `source` descriptor.
2. Implement `discoverRoot` with version + root node + unit roots.
3. Implement `planUnit` to create structural nodes and section shard items.
4. Implement `loadShardItems` to produce section content blocks.
5. Add URL normalization and parsing helpers.
6. Add deterministic designator normalization/sort helpers.
7. Add or adapt cross-reference extraction for the source citation grammar.
8. Add fixtures and tests including the simple baseline text-comparison test.
9. Wire workflow entrypoint (`workflow.ts`) to `runGenericWorkflow`.
10. Export public parser/fetcher utilities through package index if needed.

## 10. References in This Codebase

- Generic workflow contract: `packages/ingest/src/lib/workflows/generic/types.ts`
- Generic runner: `packages/ingest/src/lib/workflows/generic/runner.ts`
- USC adapter/parser: `packages/ingest/src/lib/usc/adapter.ts`, `packages/ingest/src/lib/usc/parser.ts`
- USC fetcher: `packages/ingest/src/lib/usc/fetcher.ts`
- CGA adapter/parser: `packages/ingest/src/lib/cga/adapter.ts`, `packages/ingest/src/lib/cga/parser.ts`
- CGA workflow helpers: `packages/ingest/src/lib/cga/workflow-helpers.ts`
- Example USC parser tests: `packages/ingest/src/__tests__/usc-parser.test.ts`
- Example CGA parser tests: `packages/ingest/src/__tests__/cga.test.ts`
