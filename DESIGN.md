# Connecticut Statute Search — Design Document

## Overview

A minimal, fast legal research tool for browsing and searching Connecticut General Statutes. Built on Cloudflare's edge stack (Workers, Pages, D1, R2) with SolidStart for server-rendered UI.

### Goals

- Sub-100ms page loads for browsing
- AI-powered search that answers natural language legal questions
- Clean, professional UI suitable for legal research
- Architecture that scales to additional jurisdictions and content types

### Non-Goals (MVP)

- Citation analysis / treatment
- User accounts / saved searches
- Case law
- Historical statute versions
- Traditional keyword search (FTS5)

---

## URL Structure

```
/                                       Landing page + search box
/search                                 AI search interface (RAG)
/statutes/cgs                           CT General Statutes root (title listing)
/statutes/cgs/title/{title}             Chapters & sections within a title
/statutes/cgs/chapter/{chapter}         Sections within a chapter
/statutes/cgs/section/{title}/{sec}     Individual section view
```

Examples:
```
/statutes/cgs/title/21a                 Title 21a (Consumer Protection)
/statutes/cgs/chapter/420d              Chapter 420d (Palliative Use of Marijuana)
/statutes/cgs/section/21a/279           § 21a-279 (Penalty for illegal manufacture...)
```

Note: This structure exposes titles, chapters, and sections as first-class browsable entities while keeping the URL hierarchy clear and extensible to other jurisdictions.

---

## Data Model

### D1 Schema

```sql
-- Titles (top-level grouping)
CREATE TABLE titles (
  id TEXT PRIMARY KEY,            -- '21a'
  name TEXT NOT NULL,             -- 'Consumer Protection'
  sort_order INTEGER NOT NULL
);

-- Chapters (browsable in UI via /statutes/cgs/chapter/{id})
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,            -- '420d'
  title_id TEXT NOT NULL REFERENCES titles(id),
  name TEXT NOT NULL,             -- 'Palliative Use of Marijuana'
  sort_order INTEGER NOT NULL
);

-- Sections (metadata only; full content in R2)
CREATE TABLE sections (
  id TEXT PRIMARY KEY,            -- '21a-279'
  title_id TEXT NOT NULL REFERENCES titles(id),
  chapter_id TEXT REFERENCES chapters(id),
  section_number TEXT NOT NULL,   -- '279'
  section_label TEXT,             -- 'Sec. 21a-279.'
  heading TEXT,                   -- 'Penalty for illegal manufacture...'
  r2_key TEXT NOT NULL,           -- Key to full content JSON in R2
  see_also TEXT,                  -- JSON array of related section IDs
  prev_section_id TEXT,           -- For prev/next navigation
  next_section_id TEXT,           -- For prev/next navigation
  sort_order INTEGER NOT NULL,

  UNIQUE(title_id, section_number)
);

-- Indexes for browsing
CREATE INDEX idx_sections_title ON sections(title_id, sort_order);
CREATE INDEX idx_chapters_title ON chapters(title_id, sort_order);
```

### R2 Content Storage

Full section content (body, history, annotations) is stored in R2 as JSON. D1 holds only metadata for browsing and navigation. This keeps D1 lean and allows flexible, jurisdiction-agnostic content structures.

#### R2 Key Structure

```
sections/{jurisdiction}/{section_id}.json
```

Examples:
```
sections/cgs/21a-279.json
sections/usc/26-501.json      # Future: federal statutes
```

#### Content JSON Schema

Content is stored as an array of labeled blocks. This format is jurisdiction-agnostic — different sources define their own block types.

```typescript
interface SectionContent {
  version: 1;
  section_id: string;
  blocks: ContentBlock[];
}

interface ContentBlock {
  type: string;       // Block type identifier
  label?: string;     // Optional display label
  content: string;    // Block content (plain text or HTML)
}
```

#### Block Types by Jurisdiction

**Connecticut General Statutes (`cgs`):**

| Block Type | Label | Description |
|------------|-------|-------------|
| `body` | — | Main statute text |
| `history_short` | "History" | Brief amendment history |
| `history_long` | "Full History" | Complete legislative history |
| `citations` | "Citations" | Statutory citations |
| `annotations` | "Annotations" | Editorial notes |

**Example CT Section:**

```json
{
  "version": 1,
  "section_id": "21a-279",
  "blocks": [
    {
      "type": "body",
      "content": "(a) Any person who manufactures, distributes, sells..."
    },
    {
      "type": "history_short",
      "label": "History",
      "content": "(P.A. 81-472, S. 89, 159; P.A. 98-94, S. 3...)"
    },
    {
      "type": "history_long",
      "label": "Full History",
      "content": "1981: P.A. 81-472 effective July 1, 1981..."
    },
    {
      "type": "citations",
      "label": "Citations",
      "content": "Cited. 204 C. 17; 211 C. 258..."
    }
  ]
}
```

**Future: US Code (`usc`):**

| Block Type | Label | Description |
|------------|-------|-------------|
| `body` | — | Main statute text |
| `notes` | "Notes" | Statutory notes |
| `references` | "References" | Cross-references |
| `effective_date` | "Effective Date" | Effective date info |

#### Fetching Content

```typescript
// src/lib/content.ts
import { getRequestEvent } from "solid-js/web";

export async function getSectionContent(
  jurisdiction: string,
  sectionId: string
): Promise<SectionContent> {
  const event = getRequestEvent();
  const r2 = event?.env?.STORAGE as R2Bucket;

  const key = `sections/${jurisdiction}/${sectionId}.json`;
  const object = await r2.get(key);

  if (!object) {
    throw new Error(`Section not found: ${key}`);
  }

  return object.json();
}
```

#### Rendering Blocks

```typescript
// src/components/SectionContent.tsx
function SectionContent(props: { content: SectionContent }) {
  return (
    <article>
      <For each={props.content.blocks}>
        {(block) => (
          <section class={`block block-${block.type}`}>
            <Show when={block.label}>
              <h3>{block.label}</h3>
            </Show>
            <div innerHTML={block.content} />
          </section>
        )}
      </For>
    </article>
  );
}
```

---

## Search Implementation

Search is powered by an agentic RAG (Retrieval-Augmented Generation) system that answers natural language legal questions by iteratively searching and reading statutes.

### Agentic Search (RAG)

An AI-powered search that answers natural language legal questions by iteratively searching and reading statutes.

#### Architecture

- **LLM**: Google Gemini for orchestration and response generation
- **Vector Store**: Pinecone for semantic similarity search
- **Embeddings**: `llama-text-embed-v2` (2048 dimensions)

#### Agent Tools

```typescript
interface AgentTools {
  // Semantic search over statute embeddings
  semantic_search(query: string, topK: number): Promise<{
    id: string;
    score: number;
    snippet: string;
  }[]>;

  // Fetch full statute text by ID
  read_statute(ids: string[], maxTokens: number): Promise<{
    id: string;
    title: string;
    content: string;
  }[]>;
}
```

#### Workflow

1. User submits natural language question
2. Agent plans search strategy
3. Agent calls `semantic_search` to find relevant sections
4. Agent calls `read_statute` to read full text of promising matches
5. Agent iterates (up to 6 steps) until confident
6. Agent synthesizes answer with citations

#### API

```typescript
// POST /api/chat
// Request: { question: string }
// Response: Server-Sent Events stream

interface ChatEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'sources';
  data: unknown;
}
```

#### Pinecone Index Structure

```typescript
interface PineconeRecord {
  id: string;           // section_id + chunk index
  values: number[];     // 2048-dim embedding
  metadata: {
    section_id: string;
    title_id: string;
    heading: string;
    chunk_text: string; // 2048 char chunks
  };
}
```

---

## Application Architecture

### Project Structure

```
fastlaw/
├── src/
│   ├── routes/
│   │   ├── index.tsx                           # Landing page
│   │   ├── search.tsx                          # AI search interface (RAG)
│   │   ├── api/
│   │   │   └── search.ts                       # Agentic RAG API (SSE)
│   │   └── statutes/
│   │       └── cgs/
│   │           ├── index.tsx                   # Title listing
│   │           ├── title/
│   │           │   └── [title].tsx             # Chapters & sections in title
│   │           ├── chapter/
│   │           │   └── [chapter].tsx           # Sections in chapter
│   │           └── section/
│   │               └── [title]/
│   │                   └── [section].tsx       # Section view
│   ├── components/
│   │   ├── SearchBox.tsx
│   │   ├── SearchInterface.tsx                 # Agentic search UI
│   │   ├── StatuteContent.tsx
│   │   ├── TitleList.tsx
│   │   ├── ChapterList.tsx
│   │   ├── SectionList.tsx
│   │   └── ui/                                 # solid-ui components
│   ├── lib/
│   │   ├── db.ts                               # D1 client wrapper
│   │   ├── content.ts                          # R2 content fetching
│   │   ├── agent.ts                            # RAG agent logic
│   │   ├── pinecone.ts                         # Pinecone client
│   │   └── types.ts                            # Shared types
│   └── entry-server.tsx
├── db/
│   ├── schema.sql
│   └── migrations/
├── scripts/
│   ├── ingest.ts                               # Import statutes to D1 + R2
│   └── seed_pinecone.ts                        # Seed vector embeddings
├── wrangler.toml
├── app.config.ts
└── package.json
```

### Wrangler Configuration

```toml
name = "fastlaw"
compatibility_date = "2024-01-01"
pages_build_output_dir = ".output/public"

[[d1_databases]]
binding = "DB"
database_name = "fastlaw"
database_id = "<your-database-id>"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "statute-content"
```

### SolidStart Configuration

```typescript
// app.config.ts
import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    preset: "cloudflare-pages",
  },
});
```

---

## Pages & Components

### Landing Page (`/`)

- Logo/title
- Large search box for AI-powered search
- Quick links to browse by title
- Brief description/disclaimer

### Search (`/search`)

- Search box with question input
- Workflow visualization (thinking, tool calls, results)
- Source citations with expandable snippets
- Streaming response display
- Suggested follow-up questions

### Title Listing (`/statutes/cgs`)

- Grid or list of all titles
- Title number + name
- Section count per title

### Title Detail (`/statutes/cgs/title/{title}`)

- Title heading
- Breadcrumb: Home > CT General Statutes > Title 21a
- List of chapters (if any) with section counts
- List of sections (number + heading, linked)
- Search within title (future enhancement)

### Chapter Detail (`/statutes/cgs/chapter/{chapter}`)

- Chapter heading
- Breadcrumb: Home > CT General Statutes > Title 21a > Chapter 420d
- List of sections (number + heading, linked)

### Section View (`/statutes/cgs/section/{title}/{section}`)

- Breadcrumb
- Citation: Conn. Gen. Stat. § 21a-279
- Heading
- Full text content
- Metadata: effective date, chapter
- Prev/Next section navigation
- Related sections ("See also")

---

## Data Ingestion

### Expected Input Format

The existing SQLite database (`cga_sections.sqlite3`) contains the source data. Migration splits this into D1 (metadata) and R2 (content):

```typescript
// Current SQLite schema (source)
interface SQLiteSection {
  section_id: string;        // "21a-279"
  chapter_id: string;        // "420d"
  title_id: string;          // "21a"
  section_number: string;    // "279"
  section_title: string;     // "Penalty for illegal manufacture..."
  section_label: string;     // "Sec. 21a-279."
  body: string;              // Full text content
  history_short: string;
  history_long: string;
  citations: string;         // JSON array
  see_also: string;          // JSON array of related section IDs
  prev_section_id: string;
  next_section_id: string;
}

// Migration output:
// - D1: metadata only (no content)
// - R2: full content as blocks (body, history_short, history_long, citations)
// - Pinecone: vector embeddings for semantic search
```

### Ingestion Script

```typescript
// scripts/ingest.ts
import { readFile } from 'fs/promises';

interface IngestConfig {
  inputFile: string;      // Path to JSON from your scraper
  d1Database: string;     // Database binding name
}

async function ingest(config: IngestConfig) {
  const data: IngestedSection[] = JSON.parse(
    await readFile(config.inputFile, 'utf-8')
  );

  // 1. Extract unique titles, chapters
  // 2. Compute sort orders
  // 3. Insert titles to D1
  // 4. Insert chapters to D1
  // 5. Insert section metadata to D1
  // 6. Upload section content blocks to R2
}
```

Run locally against D1:
```bash
wrangler d1 execute fastlaw --local --file=./db/schema.sql
npx tsx scripts/ingest.ts --input=./data/statutes.json
```

---

## Performance Considerations

### D1 + R2 + Pinecone Architecture

- **D1 for metadata**: Titles, chapters, section metadata. Keeps D1 small and fast for browsing.
- **R2 for full content**: Section body, history, citations stored as JSON in R2. Fetched on-demand when viewing a section.
- **Pinecone for search**: Vector embeddings enable semantic search. Agent reads full content from R2 when needed.
- **Batch reads**: When listing sections, fetch metadata in single D1 query. R2 content fetched only for section detail view.

### Performance Characteristics

| Operation | Data Source | Expected Latency |
|-----------|-------------|------------------|
| Title/chapter listing | D1 | <10ms |
| Section metadata | D1 | <10ms |
| Section full content | R2 | <50ms |
| AI search | Pinecone + R2 + Gemini | 2-10s |

### Caching Strategy

```typescript
// In route loaders, set cache headers for static-ish content
export function loader({ params, request }) {
  const response = await fetchSection(params.section);
  
  return new Response(JSON.stringify(response), {
    headers: {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
```

- Browse pages: Cache aggressively (statutes change infrequently)
- R2 content: Cache with long TTL (content rarely changes)
- Search responses: No cache (AI responses are dynamic)

### Future: Edge Caching

If D1 latency becomes problematic:
1. Cache hot sections in Workers KV
2. Use Cache API for rendered pages
3. Pre-render popular sections at build time

---

## Future Enhancements (Post-MVP)

### Near-term
- Search within specific title (scope filter)
- Print / export section
- Table of contents sidebar on section view
- Conversation history persistence

### Medium-term
- Additional jurisdictions (federal, other states)
- Case law integration
- Citation linking
- Historical versions (time travel)
- Traditional keyword search (FTS5) as alternative

### Long-term
- User accounts + saved searches
- Annotations
- API access for integrations

---

## Migration from Current Architecture

This section documents the conversion from the existing Astro-based static site to SolidStart with Cloudflare D1.

### Current State (Pre-Migration)

| Aspect | Current Implementation |
|--------|------------------------|
| Framework | Astro 4.15 (static site generator) |
| Rendering | Static HTML pre-rendered at build time |
| Database | Local SQLite (`cga_sections.sqlite3`) |
| Search | Agentic RAG only (Gemini + Pinecone) |
| Data | 30,570 sections, 1,143 chapters, ~84 titles |
| Deployment | Cloudflare Workers (search API only) + static files |

### Target State (Post-Migration)

| Aspect | Target Implementation |
|--------|----------------------|
| Framework | SolidStart |
| Rendering | Server-side rendering from D1/R2 at request time |
| Database | Cloudflare D1 (metadata) + R2 (content) + Pinecone (vectors) |
| Search | Agentic RAG (Gemini + Pinecone) |
| Data | Same content, split between D1 (metadata) and R2 (blocks) |
| Deployment | Cloudflare Pages (full-stack SolidStart) |

### Migration Steps

#### 1. Set Up SolidStart Project

```bash
# Initialize new SolidStart project
npm create solid@latest fastlaw
cd fastlaw
npm install @solidjs/router @solidjs/start

# Configure for Cloudflare Pages
npm install -D wrangler
```

Update `app.config.ts`:
```typescript
import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    preset: "cloudflare-pages",
  },
});
```

#### 2. Create D1 Database

```bash
# Create the database
wrangler d1 create fastlaw

# Apply schema
wrangler d1 execute fastlaw --local --file=./db/schema.sql
```

#### 3. Migrate Data from SQLite to D1 + R2

The migration splits data between D1 (metadata/index) and R2 (full content):

```typescript
// scripts/migrate.ts
import Database from 'better-sqlite3';
import { writeFile, mkdir } from 'fs/promises';

const db = new Database('cga_sections.sqlite3');

// 1. Export titles and chapters to D1
const titles = db.prepare(`
  SELECT DISTINCT title_id as id, title_name as name
  FROM sections ORDER BY title_id
`).all();

const chapters = db.prepare(`
  SELECT DISTINCT chapter_id as id, title_id, chapter_name as name
  FROM sections WHERE chapter_id IS NOT NULL ORDER BY chapter_id
`).all();

// 2. Export sections: metadata to D1, content to R2
const rows = db.prepare(`
  SELECT section_id, title_id, chapter_id, section_number,
         section_label, section_title, body,
         history_short, history_long, citations,
         see_also, prev_section_id, next_section_id
  FROM sections ORDER BY title_id, section_number
`).all();

const d1Sections = [];
await mkdir('data/r2/sections/cgs', { recursive: true });

for (const row of rows) {
  // D1 record (metadata only)
  d1Sections.push({
    id: row.section_id,
    title_id: row.title_id,
    chapter_id: row.chapter_id,
    section_number: row.section_number,
    section_label: row.section_label,
    heading: row.section_title,
    r2_key: `sections/cgs/${row.section_id}.json`,
    see_also: row.see_also,
    prev_section_id: row.prev_section_id,
    next_section_id: row.next_section_id,
  });

  // R2 content (block format)
  const content = {
    version: 1,
    section_id: row.section_id,
    blocks: [
      { type: 'body', content: row.body },
      row.history_short && {
        type: 'history_short',
        label: 'History',
        content: row.history_short
      },
      row.history_long && {
        type: 'history_long',
        label: 'Full History',
        content: row.history_long
      },
      row.citations && {
        type: 'citations',
        label: 'Citations',
        content: row.citations
      },
    ].filter(Boolean),
  };

  await writeFile(
    `data/r2/sections/cgs/${row.section_id}.json`,
    JSON.stringify(content, null, 2)
  );
}

// Write D1 import files
await writeFile('data/d1/titles.json', JSON.stringify(titles));
await writeFile('data/d1/chapters.json', JSON.stringify(chapters));
await writeFile('data/d1/sections.json', JSON.stringify(d1Sections));
```

Run migration:
```bash
# Export from SQLite
npx tsx scripts/migrate.ts

# Import to D1
wrangler d1 execute fastlaw --local --file=./db/schema.sql
npx tsx scripts/ingest-d1.ts

# Upload to R2 (local dev)
wrangler r2 object put statute-content/sections/cgs/ --local --pipe < data/r2/sections/cgs/*

# Or use the R2 API for bulk upload
npx tsx scripts/upload-r2.ts
```

#### 4. Recreate Routes in SolidStart

Map existing Astro pages to SolidStart routes:

| Astro Page | SolidStart Route |
|------------|------------------|
| `src/pages/index.astro` | `src/routes/index.tsx` |
| `src/pages/search.astro` | `src/routes/search.tsx` |
| `src/pages/titles/index.astro` | `src/routes/statutes/cgs/index.tsx` |
| `src/pages/titles/[title].astro` | `src/routes/statutes/cgs/title/[title].tsx` |
| `src/pages/chapters/[chapter].astro` | `src/routes/statutes/cgs/chapter/[chapter].tsx` |
| `src/pages/sections/[title]/[section].astro` | `src/routes/statutes/cgs/section/[title]/[section].tsx` |

#### 5. Convert Astro Components to Solid

Key conversions:
- `.astro` files → `.tsx` with Solid components
- Astro's `---` frontmatter → SolidStart `createRouteData` / server functions
- `Astro.params` → `useParams()`
- Static data fetching → D1 queries in route loaders

Example conversion:
```typescript
// Before: src/pages/sections/[title]/[section].astro
---
const { title, section } = Astro.params;
const data = db.prepare('SELECT * FROM sections WHERE ...').get();
---
<Layout>{data.body}</Layout>

// After: src/routes/statutes/cgs/section/[title]/[section].tsx
import { createAsync, RouteDefinition } from "@solidjs/start";
import { getSection } from "~/lib/db";

export const route: RouteDefinition = {
  load: ({ params }) => getSection(params.title, params.section),
};

export default function SectionPage() {
  const data = createAsync(() => getSection(params.title, params.section));
  return <Layout>{data()?.body}</Layout>;
}
```

#### 6. Migrate Agentic Search

Move the existing Workers search logic (`workers/search.ts`) into SolidStart API routes:

```typescript
// src/routes/api/search.ts
import { eventStream } from "@solidjs/start/server";

export async function POST({ request, env }) {
  const { question } = await request.json();

  return eventStream(request, (send) => {
    // Existing agent logic from workers/search.ts
    // Use env.PINECONE_API_KEY, env.GEMINI_API_KEY, etc.
  });
}
```

#### 7. Update Wrangler Configuration

```toml
name = "fastlaw"
compatibility_date = "2024-01-01"
pages_build_output_dir = ".output/public"

[[d1_databases]]
binding = "DB"
database_name = "fastlaw"
database_id = "<your-database-id>"

[vars]
PINECONE_INDEX_NAME = "cgs"
PINECONE_EMBED_MODEL = "llama-text-embed-v2"
# ... other env vars
```

#### 8. Deploy

```bash
# Build SolidStart for Cloudflare Pages
npm run build

# Deploy
wrangler pages deploy .output/public
```

### What to Keep

- **Pinecone index**: Keep existing vector embeddings (no re-seeding needed)
- **Gemini integration**: Port agent logic to SolidStart API routes
- **Styling**: Port CSS/Tailwind styles to new components
- **Data parsing scripts**: Keep Python scripts for future data updates
- **Source data**: SQLite serves as migration source; content restructured into R2 blocks

### What to Remove

- Astro framework and configuration
- Static build output (`/dist`)
- Local SQLite file (after D1+R2 migration verified)
- Separate Workers project (merged into SolidStart)

---

## Development Phases

### Phase 1: SolidStart Setup & Data Migration
- [ ] Initialize SolidStart project with Cloudflare Pages preset
- [ ] Create D1 database and R2 bucket
- [ ] Apply D1 schema
- [ ] Write migration script (SQLite → D1 metadata + R2 content blocks)
- [ ] Upload content JSON files to R2
- [ ] Verify data integrity after migration

### Phase 2: Core Browsing Routes
- [ ] Landing page (`/`)
- [ ] Title listing (`/statutes/cgs`)
- [ ] Title detail (`/statutes/cgs/title/[title]`)
- [ ] Chapter detail (`/statutes/cgs/chapter/[chapter]`)
- [ ] Section view (`/statutes/cgs/section/[title]/[section]`)

### Phase 3: Agentic Search Migration
- [ ] Port Workers search logic to SolidStart API route (`/api/search`)
- [ ] Recreate search interface (`/search`)
- [ ] Verify Pinecone + Gemini integration works
- [ ] Update agent to fetch content from R2

### Phase 4: Polish & Deploy
- [ ] Port styles / implement solid-ui components
- [ ] Responsive design
- [ ] Error handling & loading states
- [ ] Production D1 + R2 + Cloudflare Pages deployment
- [ ] Domain setup