# Schema Extension Sketch

Goal: extend current CT statutes-only model to support multi-jurisdiction statutes (state + US Code) and additional doc types (cases, regulations) while preserving existing CT browsing paths. This follows `DESIGN.md`: keep D1 metadata lean, store full content in R2, keep URLs stable, and remain extensible.

## Current State (summary)
- D1 tables: `titles`, `chapters`, `sections` (CT-specific hierarchy).
- R2 content: `SectionContent { version: 1, section_id, blocks[] }`.
- App queries assume CT title/chapter/section identifiers and CT-style numbering.

## Design Principles
- Keep CT statutes working without a rewrite.
- Add a generic source layer for new jurisdictions and doc types.
- Prefer a flexible breadcrumb/outline model over hard-coded title/chapter/section tables.
- Add explicit source and document slug handling consistent with R2 key design.
- Support multiple versions (as_of/effective) without defensive programming.

## Proposed Data Model

### 1) Sources
```
Table: sources
- id (TEXT, primary key)              -- e.g., "cgs" / "usc" / "ct_regs" / "us_cases"
- name (TEXT)                         -- "Connecticut General Statutes", "United States Code"
- jurisdiction (TEXT)                 -- "state" | "federal"
- region (TEXT)                       -- "CT" / "US" / "NY" ...
- doc_type (TEXT)                     -- "statute" | "regulation" | "case"
- edition (TEXT)                      -- optional "2024" / "2023" / "2022" etc
- citation_prefix (TEXT)              -- optional, e.g. "Conn. Gen. Stat." / "U.S.C."
- slug (TEXT)                         -- URL prefix segment (e.g., "cgs", "usc")
- sort_order (INTEGER)
```

### 2) Levels (Breadcrumbs) + Documents
```
Table: documents
- id (TEXT, primary key)              -- stable doc id
- source_id (TEXT, not null)          -- FK -> sources.id
- doc_type (TEXT, not null)           -- "statute" | "regulation" | "case"
- title (TEXT)                        -- display title
- citation (TEXT)                     -- e.g., "21a-279" / "42 U.S.C. § 1983"
- slug (TEXT, not null)               -- URL path + R2 path (append ".json")
- as_of (TEXT)                        -- ISO date string
- effective_start (TEXT)              -- ISO date string
- effective_end (TEXT)                -- ISO date string
- source_url (TEXT)
- created_at (TEXT)
- updated_at (TEXT)

Table: levels
- id (TEXT, primary key)
- source_id (TEXT, not null)          -- FK -> sources.id
- doc_type (TEXT, not null)           -- matches documents.doc_type
- level_index (INTEGER, not null)     -- 0..n, defines breadcrumb order
- level_name (TEXT, not null)         -- "title" | "chapter" | "part" | "section" | "article" | etc
- label (TEXT)                        -- display label ("Title 21A", "§ 21a-279")
- identifier (TEXT)                   -- canonical id for matching ("21a-279")
- identifier_sort (TEXT)              -- normalized for ordering
- name (TEXT)                         -- heading/name
- parent_id (TEXT)                    -- FK -> levels.id
- doc_id (TEXT)                       -- FK -> documents.id (only for leaf nodes or any node with content)
- sort_order (INTEGER)
```

### 3) Content Schema (R2)

#### Unified content envelope
```
DocumentContent {
  version: 2,
  doc_id: string,
  doc_type: "statute" | "regulation" | "case",
  blocks: ContentBlock[],
  metadata: {
    citations?: string[],
    parties?: string[],
    court?: string,
    docket?: string,
    decision_date?: string,
    agency?: string,
    source?: string,
  }
}
```

- Keep existing `SectionContent` (version 1) for CT, add a converter for display.
- New content should be version 2 only.
- `documents.slug` is both the URL path and the R2 key path, so the content fetch key is `${slug}.json`.

## Mapping Current CT Statutes into New Model

### Strategy
- Preserve `titles`, `chapters`, `sections` for now.
- Introduce `sources`, `documents`, `levels` alongside.
- Backfill CT data into new tables using CT data as a first source (`source_id = "cgs"`).

### Mapping
- Each CT `section` becomes one `documents` row (`doc_type = "statute"`), with `slug = "statutes/cgs/section/{title}/{sec}"`. R2 content is stored at `${slug}.json` so URL and storage are aligned.
- Each CT `title`/`chapter`/`section` becomes a `levels` row with `level_index` = `0/1/2` and `level_name` = `title/chapter/section`.
- `levels.doc_id` is set for sections; title/chapter rows are structural only.

## Extensibility Notes

### 1) Other States + US Code
- Use `sources` to separate jurisdiction + edition.
- `levels.level_name` supports variations (e.g., "subtitle", "part", "division").
- `identifier_sort` handles jurisdiction-specific ordering (e.g., 42 U.S.C. §§ 1981–1983).

### 2) Regulations
- Use `doc_type = "regulation"`.
- `levels.level_name` can include "title"/"part"/"section" and agency-specific containers.
- Keep `documents.citation` as the canonical CFR or state reg citation.

### 3) Cases
- Use `doc_type = "case"`.
- Cases often do not fit a deep outline; can use a single `levels` row at level "case".
- Store citations, court, decision date in `DocumentContent.metadata`.

## Suggested Queries (high level)

### Browse source hierarchy
- Fetch `levels` by `source_id`, `doc_type`, `parent_id` ordered by `identifier_sort` and `sort_order`.

### Fetch doc content
- Look up `documents` by `id` -> fetch `${slug}.json` -> render `DocumentContent`.

## Migration Plan (incremental)
1. Add `sources`, `documents`, `levels` tables in D1.
2. Backfill CT data into new tables from existing CT tables.
3. Update API to query `levels` for new browsing experiences.
4. Keep CT routes using old tables until UI is migrated.
5. Introduce new routes for multi-source browsing (e.g., `/sources/:sourceId/...`).

## Minimal Changes Needed in App
- Add a `Source`, `Level`, and `Document` type in `src/lib/types.ts`.
- Add new DB helpers for fetching `sources`, `levels`, and `documents`.
- Add a content reader that accepts both `SectionContent` and `DocumentContent` using `slug`.

## Open Questions
- How should editioning/versioning be surfaced in the UI?
- Do we need per-node effective dates or only per-document?
- Are we indexing non-leaf nodes with content (e.g., parts that have text)?
