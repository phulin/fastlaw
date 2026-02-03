# State Statute Parser Specification

A comprehensive guide for building autonomous statute parsers for US state legal codes, based on the Connecticut General Statutes (CGS) implementation.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Document Hierarchy Model](#2-document-hierarchy-model)
3. [URL Crawling Strategy](#3-url-crawling-strategy)
4. [HTML Parsing Strategy](#4-html-parsing-strategy)
5. [Section Identification & Normalization](#5-section-identification--normalization)
6. [Cross-Reference Extraction](#6-cross-reference-extraction)
7. [Content Block Structure](#7-content-block-structure)
8. [Database Schema](#8-database-schema)
9. [Edge Cases & Special Handling](#9-edge-cases--special-handling)
10. [Implementation Checklist](#10-implementation-checklist)
11. [LLM Prompt Template](#11-llm-prompt-template)

---

## 1. Architecture Overview

### Design Principles

The parser follows a **parse-during-crawl** architecture for memory efficiency:

```
Web Crawler (BFS)
    │
    ▼ (fetches HTML pages)
HTML Parser (integrated - parse immediately)
    │
    ▼ (extracts structured data)
Database + Blob Storage
```

**Key insight**: Parse HTML once during the crawl and store parsed data immediately. Do NOT store raw HTML and parse later - this consumes excessive memory for large legal codebases.

### Technology Stack (Reference Implementation)

- **Runtime**: Cloudflare Workers (or Node.js for local dev)
- **Database**: D1 (SQLite-compatible)
- **Blob Storage**: R2 (S3-compatible)
- **HTML Parser**: `htmlparser2` (streaming SAX-style parser)
- **Language**: TypeScript

---

## 2. Document Hierarchy Model

### Hierarchy Structure

Most US state statutes follow a hierarchical structure. The CGS implementation uses:

```
Root (source root)
├── Title (top-level division)
│   └── Chapter/Article (intermediate division)
│       └── Section (leaf node with actual statute text)
```

### Level Configuration

| Level | levelIndex | levelName | Example stringId | heading_citation |
|-------|-----------|-----------|------------------|------------------|
| Root | -1 | root | cgs/root | CGS |
| Title | 0 | title | cgs/title/42a | Title 42a |
| Chapter | 1 | chapter | cgs/chapter/377a | Chapter 377a |
| Article | 1 | article | cgs/article/2a | Article 2a |
| Section | 2 | section | cgs/section/20-86aa | CGS § 20-86aa |

### stringId Format

```
{source_code}/{level_name}/{normalized_designator}
```

Examples:
- `cgs/root` - Root node
- `cgs/title/42a` - Title 42a
- `cgs/chapter/377a` - Chapter 377a
- `cgs/section/20-86aa` - Section 20-86aa

### Alternative Intermediate Levels

Some titles use "Articles" instead of "Chapters" (e.g., the Uniform Commercial Code). The parser must handle both:

- **Chapters**: `chap_XXX.htm` → `cgs/chapter/XXX`
- **Articles**: `art_XXX.htm` → `cgs/article/XXX`

Some states may have additional levels:
- Parts
- Subparts
- Divisions
- Subtitles

---

## 3. URL Crawling Strategy

### URL Pattern Detection

The CGS implementation detects page types from URL patterns:

```typescript
type PageUrlInfo =
  | { type: "title"; id: string }    // title_XX.htm
  | { type: "chapter"; id: string }  // chap_XXX.htm
  | { type: "article"; id: string }  // art_XXX.htm
  | { type: "index" }                // titles.htm, index.htm
  | { type: "other" };
```

### URL Normalization

Critical normalization steps:

1. **Reject special protocols**: `mailto:`, `javascript:`
2. **Resolve relative URLs**: Use `new URL(href, baseUrl)`
3. **Validate domain**: Only allow the official state domain
4. **Validate path prefix**: Only crawl statute pages (e.g., `/current/pub/`)
5. **Normalize case**: Many servers are case-insensitive; normalize to lowercase
6. **Strip fragments**: Remove `#anchor` portions

```typescript
function normalizeLink(href: string, baseUrl: string): string | null {
  if (href.startsWith("mailto:") || href.startsWith("javascript:")) {
    return null;
  }

  const fullUrl = new URL(href, baseUrl);

  if (fullUrl.hostname !== ALLOWED_HOST) return null;
  if (!fullUrl.pathname.startsWith(ALLOWED_PREFIX)) return null;

  fullUrl.pathname = fullUrl.pathname.toLowerCase();
  fullUrl.hash = "";

  return fullUrl.toString();
}
```

### Crawl Configuration

```typescript
interface CrawlerConfig {
  maxPages: number;      // 2000 (default) - safety limit
  concurrency: number;   // 20 (default) - parallel requests
  timeoutMs: number;     // 30000 (default) - 30 second timeout
  userAgent: string;     // Identify your crawler
}
```

### BFS Crawl Algorithm

```typescript
async function crawl(startUrl: string): Promise<CrawlResult> {
  const seen = new Set<string>();
  const queue: string[] = [startUrl];
  const semaphore = new Semaphore(config.concurrency);

  while (queue.length > 0 && pagesCrawled < config.maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    await semaphore.acquire();
    try {
      const html = await fetch(url);
      const page = parsePage(html, url);  // Parse immediately!

      // Store parsed data
      storePageData(page);

      // Extract and queue new links
      const links = extractLinks(html, url);
      queue.push(...links.filter(link => !seen.has(link)));
    } finally {
      semaphore.release();
    }
  }
}
```

---

## 4. HTML Parsing Strategy

### Two-Pass Parsing

The CGS parser uses a sophisticated two-pass approach within a single parse:

**Pass 1: TOC Extraction**
- Find TOC header element (e.g., `h4.chap_toc_hd`)
- Extract all anchor links (`a[href^="#"]`) mapping to section IDs
- Build a `tocAnchorId → label text` map
- TOC ends at a delimiter (e.g., `hr.chaps_pg_bar`)

**Pass 2: Body Extraction**
- Detect section markers (e.g., `span.catchln` with `id` attribute)
- Extract content following each marker
- Route content to appropriate blocks by CSS class

### Content Target Routing

Route HTML content to different blocks based on CSS classes:

| CSS Class | Target Block | Description |
|-----------|--------------|-------------|
| `source`, `source-first` | `history_short` | Source acts (e.g., "P.A. 23-147") |
| `history`, `history-first` | `history_long` | Full legislative history |
| `annotation`, `annotation-first` | `citations` | Case law citations |
| `cross-ref`, `cross-ref-first` | `see_also` | Cross-references |
| (default) | `body` | Main statute text |

### HTML Element Handling

| Element | Action |
|---------|--------|
| `<script>`, `<style>` | Skip entirely |
| `<table class="nav_tbl">` | Skip (navigation) |
| `<table>` (other) | Include with `\|` cell separators |
| `<tr>` | Add newline |
| `<td>`, `<th>` | Add ` \| ` between cells |
| `<br>`, `<hr>` | Add newline |
| Block tags | Add newline around |

### Text Normalization

```typescript
function formatText(parts: string[]): string {
  const raw = parts.join("");

  // Split by lines, collapse whitespace
  const lines = raw.split("\n")
    .map(line => line.split(/\s+/).join(" ").trim());

  // Normalize blank lines (max one consecutive)
  const normalized = [];
  let lastWasBlank = false;
  for (const line of lines) {
    if (line === "") {
      if (!lastWasBlank) normalized.push("");
      lastWasBlank = true;
    } else {
      normalized.push(line);
      lastWasBlank = false;
    }
  }

  return normalized.join("\n").trim();
}
```

### Trailing Heading Trimming

Section bodies sometimes include heading text for the next section. Remove patterns like:
- `PART I`, `ARTICLE V`, `CHAPTER 42`
- All-caps multi-word phrases (< 80 chars)
- Roman numeral markers: `(I)`, `(IV)`

---

## 5. Section Identification & Normalization

### Designator Formats

Connecticut uses format: `TITLE-NUMBER[SUFFIX]`

Examples:
- `4-125` - Title 4, Section 125
- `42a-1-101` - Title 42a, Article 1, Section 101
- `20-86aa` - Title 20, Section 86aa

### Normalization Functions

```typescript
// For sorting: zero-pad, lowercase
function formatDesignatorPadded(value: string, width = 4): string {
  const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
  if (!match) return value.toLowerCase();
  const number = match[1].padStart(width, "0");
  const suffix = match[2].toLowerCase();
  return `${number}${suffix}`;
}
// "42a" → "0042a", "1" → "0001"

// For display: strip leading zeros, lowercase
function formatDesignatorDisplay(value: string): string {
  const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
  if (!match) return value.toLowerCase();
  return `${Number.parseInt(match[1], 10)}${match[2].toLowerCase()}`;
}
// "042a" → "42a", "001" → "1"

// For identifiers: strip leading zeros, preserve case
function normalizeDesignator(value: string): string {
  const match = value.match(/^0*([0-9]+)([a-zA-Z]*)$/);
  if (!match) return value;
  return `${Number.parseInt(match[1], 10)}${match[2]}`;
}
// "042A" → "42A"
```

### Label Parsing

TOC labels follow patterns like:
- `Sec. 1-1. Words and phrases.`
- `Secs. 1-1o to 1-1s. Reserved`

```typescript
function parseLabel(label: string): {
  number: string | null;
  title: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
} {
  const match = label.match(/^(Secs?)\.\s+([^.]+)\.\s*(.*)$/);
  if (!match) return { number: null, title: null, rangeStart: null, rangeEnd: null };

  const number = match[2].trim();
  const title = match[3].trim() || null;

  // Parse ranges: "1-1o to 1-1s"
  if (match[1].toLowerCase().startsWith("secs")) {
    const rangeMatch = number.match(/^(.+?)\s+to\s+([^,]+)$/i);
    if (rangeMatch) {
      return { number, title, rangeStart: rangeMatch[1], rangeEnd: rangeMatch[2] };
    }
  }

  return { number, title, rangeStart: number, rangeEnd: number };
}
```

---

## 6. Cross-Reference Extraction

### Section Reference Patterns

Detect and parse legal cross-references in statute text:

- `section 4-125` or `sec. 4-125`
- `sections 4-125 and 4-126`
- `sections 4-125 to 4-130, inclusive`
- `subsection (a) of section 4-125`
- `subdivision (2) of subsection (b) of section 4-125`
- `42 U.S.C. 1983`
- `section 552 of title 5`

### Token Types

```typescript
type Token =
  | { type: "sectionNumber"; value: string; start: number; end: number }
  | { type: "designator"; value: string }  // (a), (1), (i), etc.
  | { type: "word"; value: string }
  | { type: "punct"; value: "," | ";" | "." | ":" };
```

### Qualifier Types

```typescript
type QualifierType =
  | "subsection"    // (a), (b)
  | "subdivision"   // (1), (2)
  | "paragraph"     // (A), (B)
  | "subparagraph"  // (i), (ii)
  | "clause";       // (I), (II)
```

### Cross-Reference Output

```typescript
interface SectionCrossReference {
  section: string;   // "4-125"
  titleNum?: string | null; // "42" for USC references, null for single-title codes
  offset: number;    // Character position in text
  length: number;    // Length of the mention
  link: string | null;      // "/statutes/cgs/section/4-125" or "/statutes/usc/section/42/1983"
}
```

### Grammar Patterns Supported

- **Single**: `section 4-125`
- **Lists**: `sections 4-125, 4-126, 4-127`
- **Ranges**: `sections 4-125 to 4-130, inclusive`
- **Qualified**: `subsection (a) of section 4-125`
- **Nested qualifiers**: `subdivision (2) of subsection (b) of section 4-125`
- **Mixed**: `section 4-125, section 4-126 to 4-130, section 4-200`
- **Missing spaces**: `section 4-125,4-126` (comma without space)
- **USC titles**: `42 U.S.C. 1983`, `section 552 of title 5`

---

## 7. Content Block Structure

### Node Content JSON

Stored in blob storage, keyed by xxhash64:

```typescript
interface NodeContent {
  blocks: ContentBlock[];
  metadata?: {
    cross_references?: SectionCrossReference[];
  };
}

interface ContentBlock {
  type: "body" | "history_short" | "history_long" | "citations" | "see_also";
  label?: string;  // Human-readable label
  content: string; // Formatted text
}
```

### Example Content

```json
{
  "blocks": [
    {
      "type": "body",
      "content": "(a) As used in this section:\n\n(1) \"Certified doula\" means..."
    },
    {
      "type": "history_short",
      "label": "Short History",
      "content": "(P.A. 23-147, S. 13.)"
    },
    {
      "type": "history_long",
      "label": "Long History",
      "content": "History: P.A. 23-147 effective July 1, 2023."
    },
    {
      "type": "citations",
      "label": "Citations",
      "content": "Cited in Smith v. Jones, 172 Conn. 112."
    }
  ],
  "metadata": {
    "cross_references": [
      {
        "section": "20-86bb",
        "offset": 245,
        "length": 7,
        "link": "/statutes/cgs/section/20-86bb"
      }
    ]
  }
}
```

---

## 8. Database Schema

### Tables

**sources**
```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,      -- "cgs"
  name TEXT NOT NULL,             -- "Connecticut General Statutes"
  jurisdiction TEXT NOT NULL,     -- "state"
  region TEXT NOT NULL,           -- "CT"
  doc_type TEXT NOT NULL          -- "statute"
);
```

**source_versions**
```sql
CREATE TABLE source_versions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  canonical_name TEXT NOT NULL,   -- "cgs-2024-01-15"
  version_date TEXT NOT NULL,     -- "2024-01-15"
  root_node_id INTEGER REFERENCES nodes(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**nodes**
```sql
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  source_version_id INTEGER NOT NULL REFERENCES source_versions(id),
  string_id TEXT NOT NULL,        -- "cgs/section/4-125"
  parent_id INTEGER REFERENCES nodes(id),
  level_name TEXT NOT NULL,       -- "section"
  level_index INTEGER NOT NULL,   -- 2
  sort_order INTEGER NOT NULL,    -- For ordering siblings
  name TEXT,                      -- "Words and phrases"
  path TEXT,                      -- "/statutes/cgs/section/4-125"
  readable_id TEXT,               -- "4-125"
  heading_citation TEXT,          -- "CGS § 4-125"
  blob_hash INTEGER,              -- xxhash64 as signed 64-bit int
  source_url TEXT,                -- Original URL
  accessed_at TEXT                -- ISO timestamp
);
```

**blobs** (for packfile storage)
```sql
CREATE TABLE blobs (
  hash INTEGER PRIMARY KEY,       -- xxhash64
  packfile_key TEXT NOT NULL,     -- "cgs/packfile-001.tar"
  offset INTEGER NOT NULL,        -- Byte offset in packfile
  size INTEGER NOT NULL           -- Byte length
);
```

---

## 9. Edge Cases & Special Handling

### Reserved Sections

**Pattern**: "Reserved for future use"

**Handling**: Include in database with body text containing the reservation notice.

**Example stringId**: `cgs/section/1-1o_to_1-1s`

### Transferred Sections

**Pattern**: "Transferred to Chapter X, Sec. Y-Z"

**Handling**: Include in database with body text containing transfer destination.

**Example body**: "Transferred to Chapter 14, Sec. 1-212"

### Repealed Sections/Subsections

**Pattern**: "Repealed by P.A. XX-XXX"

**Handling**:
- Include "Repealed" notice in body
- Include repeal act in `history_long`
- Still index and make searchable

### Tables in Statutes

**Pattern**: Tax rate tables, fee schedules, etc.

**Handling**:
- Convert to pipe-separated format: `cell1 | cell2 | cell3`
- Rows separated by newlines
- Preserves tabular data in plain text

### Designators with Letter Suffixes

**Examples**: `377a`, `42a`, `4c`, `20-86aa`

**Handling**:
- Case-insensitive matching
- Store lowercase in database
- Zero-pad numbers for sorting: `0042a`

### Multi-Part Section Numbers

**Examples**: `42a-1-101`, `42a-2A-404`

**Pattern**: Title-Article-Section format used in UCC

**Handling**: Preserve full hierarchy in stringId

### Duplicate Sections

**Cause**: Same section linked from multiple pages

**Handling**: Track `Set<stringId>` during ingestion, skip duplicates

### Articles vs Chapters

**Pattern**: Some titles use "Articles" instead of "Chapters"

**Handling**:
- Detect from URL (`art_*.htm` vs `chap_*.htm`)
- Store with appropriate `level_name`
- Both use `levelIndex: 1`

### TOC Mismatches

**Cause**: TOC anchor ID doesn't match section ID in body

**Handling**: Fall back to section ID from `span.catchln[id]`

### Trailing Headings in Body

**Cause**: HTML includes next section's heading in current section's body

**Handling**: Trim patterns like `PART I`, `CHAPTER 42`, all-caps phrases

---

## 10. Implementation Checklist

When building a parser for a new state, complete each section:

### Phase 1: Research & Discovery

- [ ] **Identify official statute website**
  - URL: ________________
  - Note any authentication/rate limiting

- [ ] **Document URL patterns**
  - Index page: ________________
  - Title pages: ________________
  - Chapter pages: ________________
  - Section pages (if separate): ________________

- [ ] **Document hierarchy structure**
  - Level 0 (root): ________________
  - Level 1: ________________
  - Level 2: ________________
  - Level 3 (if applicable): ________________

- [ ] **Document designator format**
  - Pattern: ________________
  - Examples: ________________

- [ ] **Document HTML structure**
  - TOC element: ________________
  - TOC link pattern: ________________
  - Section marker element: ________________
  - Content block CSS classes:
    - Body: ________________
    - History: ________________
    - Citations: ________________
    - Cross-refs: ________________

### Phase 2: Implementation

- [ ] **Implement URL normalization**
  - Domain validation
  - Path prefix validation
  - Case normalization
  - Fragment stripping

- [ ] **Implement page type detection**
  - `parsePageUrl()` function

- [ ] **Implement HTML parser**
  - TOC extraction
  - Section marker detection
  - Content block routing
  - Text normalization

- [ ] **Implement designator functions**
  - `formatDesignatorPadded()` - for sorting
  - `formatDesignatorDisplay()` - for display
  - `normalizeDesignator()` - for IDs

- [ ] **Implement cross-reference extraction**
  - Section number regex
  - Qualifier keyword map
  - Link builder

### Phase 3: Testing

- [ ] **Collect HTML fixtures**
  - Basic chapter
  - Reserved sections
  - Transferred sections
  - Repealed sections
  - Tables
  - Alternative hierarchy (articles)

- [ ] **Write unit tests**
  - Designator formatting
  - Label parsing
  - URL normalization
  - Section extraction

- [ ] **Write integration tests**
  - Full chapter parsing
  - Edge case handling

### Phase 4: Deployment

- [ ] **Create source record**
- [ ] **Configure environment variables**
- [ ] **Run initial ingestion**
- [ ] **Verify data quality**
- [ ] **Set up recurring ingestion schedule**

---

## 11. LLM Prompt Template

Use this prompt to help an LLM build a new state parser:

```
I need to build a statute parser for [STATE NAME]'s legal code.

## Website Information
- Official URL: [URL]
- Statute section: [PATH]

## Your Tasks

1. **Analyze the website structure**
   - Identify URL patterns for different page types
   - Document the HTML structure for TOC and content
   - Identify CSS classes used for different content types

2. **Document the hierarchy**
   - What are the levels? (Titles, Chapters, Sections, etc.)
   - What are the designator formats?
   - Are there alternative structures (Articles vs Chapters)?

3. **Implement the parser following this specification**
   - Use the CGS implementation as a reference
   - Handle edge cases: reserved, transferred, repealed sections
   - Support tables and complex formatting

4. **Required outputs**
   - `parsePageUrl(url)` - detect page type from URL
   - `normalizeLink(href, baseUrl)` - normalize and validate URLs
   - `parseChapterPage(html, url, id, type)` - extract sections
   - `extractSectionCrossReferences(text)` - find cross-references
   - Designator normalization functions

## Reference Implementation

See the CGS parser at:
- packages/ingest/src/lib/cga/parser.ts
- packages/ingest/src/lib/cga/crawler.ts
- packages/ingest/src/lib/cga/cross-references.ts
- packages/ingest/src/lib/cga/utils.ts
- packages/ingest/src/lib/cga/ingest.ts

## Edge Cases to Handle

1. Reserved sections ("Reserved for future use")
2. Transferred sections ("Transferred to...")
3. Repealed sections ("Repealed by...")
4. Tables (tax rates, fee schedules)
5. Designators with letter suffixes (42a, 377a)
6. Multiple hierarchy types (chapters vs articles)
7. Duplicate sections from multiple URLs
8. Trailing headings in section bodies

## Testing Requirements

Create HTML fixtures and tests for:
- Basic section extraction
- TOC parsing
- Content block separation
- Edge cases listed above
```

---

## Appendix: CGS-Specific Details

For reference, here are the Connecticut-specific patterns:

### URL Patterns
- Base: `https://www.cga.ct.gov/current/pub/`
- Index: `titles.htm`
- Titles: `title_XX.htm` (e.g., `title_42a.htm`)
- Chapters: `chap_XXX.htm` (e.g., `chap_377a.htm`)
- Articles: `art_XXX.htm` (e.g., `art_001.htm`)

### HTML Structure
- TOC header: `h4.chap_toc_hd`
- TOC links: `p.toc_catchln > a[href^="#"]`
- TOC end: `hr.chaps_pg_bar`
- Section marker: `span.catchln[id]`
- History short: `p.source`, `p.source-first`
- History long: `p.history`, `p.history-first`
- Citations: `p.annotation`, `p.annotation-first`
- Cross-refs: `p.cross-ref`, `p.cross-ref-first`
- Navigation (skip): `table.nav_tbl`

### Meta Tags
- `<meta name="Description">` - Chapter title
- `<meta name="Number">` - Chapter number

### Section Number Format
- Pattern: `\d+[a-zA-Z]*-(?:\d+[a-zA-Z]*)(?:-\d+[a-zA-Z]*)*`
- Examples: `4-125`, `42a-1-101`, `20-86aa`

### Citation Format
- Heading: `CGS § X-Y`
- In text: `section X-Y`, `sec. X-Y`, `sections X-Y and X-Z`
