# CGA Ingestion with Cloudflare Workflows

## Overview

Migrate the CGA (Connecticut General Assembly) statute ingestion from a single monolithic crawl to a Cloudflare Workflows-based architecture. Each level of the hierarchy (root → title → chapter → section batch) runs as a separate workflow step, enabling:

- **Durability**: Automatic retries on failures
- **Parallelism**: Titles and chapters process concurrently
- **Observability**: Per-step metrics and logging
- **Idempotency**: Source version-based deduplication

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CGA Ingest Workflow                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐                                                    │
│  │  Root Step  │  1. Fetch titles.htm                               │
│  │             │  2. Extract "revised to" year → canonical_name     │
│  │             │  3. Insert root node                               │
│  │             │  4. Cache HTML in R2                               │
│  │             │  5. Return { rootId, sourceVersionId, titleUrls }  │
│  └──────┬──────┘                                                    │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Title Steps (sequential)                  │    │
│  │  For each title URL:                                        │    │
│  │  1. Fetch title page                                        │    │
│  │  2. Insert title node (parent = rootId)                     │    │
│  │  3. Cache HTML in R2                                        │    │
│  │  4. Extract chapter/article URLs                            │    │
│  │  5. Return { titleId, titleNodeId, chapterUrls }            │    │
│  └──────┬──────────────────────────────────────────────────────┘    │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │               Chapter Batch Steps (batches of 20)            │    │
│  │  For each batch of up to 20 chapters:                       │    │
│  │  1. Batch includes { titleNodeId, titleId, chapters[] }     │    │
│  │  2. For each chapter in batch:                              │    │
│  │     a. Fetch chapter page                                   │    │
│  │     b. Insert chapter node (parent = titleNodeId)           │    │
│  │     c. Cache HTML in R2                                     │    │
│  │     d. Count sections                                       │    │
│  │  3. Return ChapterStepOutput[] for all chapters in batch    │    │
│  └──────┬──────────────────────────────────────────────────────┘    │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │            Section Steps (cross-chapter batches)             │    │
│  │  Sections from all chapters are packed into batches of up   │    │
│  │  to 200 items, spanning multiple chapters per batch:        │    │
│  │  1. For each item in batch (chapter slice):                 │    │
│  │     a. Fetch chapter HTML from R2 cache                     │    │
│  │     b. Parse sections in range [startIndex, endIndex)       │    │
│  │     c. Store blobs in packfile                              │    │
│  │     d. Build node inserts (parent = item.chapterNodeId)     │    │
│  │  2. Batch insert all section nodes                          │    │
│  │  3. Return { insertedCount }                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Source Version Identification

### Extracting the Revision Date

The CGA website includes a revision date indicator (e.g., "Revised to January 1, 2025"). This year is extracted and used to construct the `canonical_name`.

**Pattern to match**: `Revised to (\w+ \d+, \d{4})` or similar on `titles.htm`

**Canonical name format**: `cgs-YYYY` (e.g., `cgs-2025`)

### Database Migration

Add an index on `canonical_name` for efficient lookup:

```sql
-- Migration: 010_canonical_name_index.sql
CREATE INDEX IF NOT EXISTS idx_source_versions_canonical
  ON source_versions(canonical_name);
```

This allows idempotent workflow runs: if a workflow is triggered and `cgs-2025` already exists, we can skip or update rather than duplicate.

## R2 Caching Strategy

### Path Structure

```
sources/cga/<versionId>/<filename>.htm

Examples:
  sources/cga/2025/titles.htm
  sources/cga/2025/title_01.htm
  sources/cga/2025/chap_001.htm
  sources/cga/2025/art_002a.htm
```

The `versionId` is the year extracted from the "Revised to" text (e.g., `2025`).

### Caching Logic

```typescript
async function fetchWithCache(
  url: string,
  versionId: string,
  storage: R2Bucket,
): Promise<{ body: ReadableStream; cached: boolean }> {
  const filename = extractFilename(url); // e.g., "chap_001.htm"
  const r2Key = `sources/cga/${versionId}/${filename}`;

  // Check cache first
  const cached = await storage.get(r2Key);
  if (cached) {
    return { body: cached.body, cached: true };
  }

  // Fetch from source
  const response = await fetch(url, { /* headers */ });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  // Tee the stream: one for R2, one for processing
  const [forCache, forProcess] = response.body!.tee();

  // Store in R2 (non-blocking)
  await storage.put(r2Key, forCache, {
    httpMetadata: { contentType: 'text/html' },
  });

  return { body: forProcess, cached: false };
}
```

## Workflow Implementation

### Bindings Configuration (wrangler.toml additions)

```toml
[[workflows]]
name = "cga-ingest-workflow"
binding = "CGA_WORKFLOW"
class_name = "CGAIngestWorkflow"
```

### Type Definitions

```typescript
// packages/ingest/src/lib/cga/workflow-types.ts

export interface RootStepOutput {
  sourceVersionId: number;
  versionId: string;           // Year for R2 paths (e.g., "2025")
  canonicalName: string;       // Full canonical name (e.g., "cgs-2025")
  rootNodeId: number;
  titleUrls: string[];
}

export interface TitleStepOutput {
  titleNodeId: number;
  titleId: string;
  chapterUrls: Array<{
    url: string;
    type: 'chapter' | 'article';
  }>;
}

/** A slice of sections from a single chapter, used within cross-chapter batches */
export interface SectionBatchItem {
  chapterNodeId: number;
  chapterId: string;
  chapterUrl: string;
  startIndex: number;              // First section index (inclusive)
  endIndex: number;                // Last section index (exclusive)
}

export interface ChapterBatchItem {
  url: string;
  type: 'chapter' | 'article';
}

export interface ChapterBatch {
  titleNodeId: number;             // Parent title node ID
  titleId: string;                 // Parent title ID for path construction
  chapters: ChapterBatchItem[];    // Up to 20 chapters per batch
}

export interface ChapterStepOutput {
  chapterNodeId: number;
  chapterId: string;
  chapterUrl: string;              // For section steps to fetch from R2 cache
  totalSections: number;
}

export interface SectionBatchOutput {
  insertedCount: number;
}
```

### Workflow Class

```typescript
// packages/ingest/src/lib/cga/workflow.ts

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from 'cloudflare:workers';
import type { Env } from '../../types';
import type {
  ChapterBatch,
  ChapterStepOutput,
  RootStepOutput,
  TitleStepOutput,
} from './workflow-types';
import {
  extractVersionId,
  fetchWithCache,
  parseTitlePage,
  parseChapterPage,
} from './workflow-helpers';

export class CGAIngestWorkflow extends WorkflowEntrypoint<Env, GenericWorkflowParams> {

  async run(
    event: WorkflowEvent<GenericWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { force = false } = event.payload;

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Root - fetch titles.htm, extract version, insert root
    // ═══════════════════════════════════════════════════════════════
    const root = await step.do('root', async (): Promise<RootStepOutput> => {
      const startUrl = `${this.env.CGA_BASE_URL}${this.env.CGA_START_PATH}`;

      // Fetch and parse root page to get version
      const response = await fetch(startUrl);
      const html = await response.text();
      const versionId = extractVersionId(html);        // e.g., "2025"
      const canonicalName = `cgs-${versionId}`;        // e.g., "cgs-2025"

      // Check if version already exists
      const existingVersion = await this.env.DB.prepare(`
        SELECT id FROM source_versions
        WHERE canonical_name = ?
      `).bind(canonicalName).first<{ id: number }>();

      if (existingVersion && !force) {
        throw new Error(`Version ${canonicalName} already exists (id=${existingVersion.id}). Use force=true to re-ingest.`);
      }

      // Get or create source
      const sourceId = await getOrCreateSource(this.env.DB, 'cgs', 'Connecticut General Statutes', 'state', 'CT', 'statute');

      // Create source version (uses canonical_name for deduplication)
      const versionDate = new Date().toISOString().split('T')[0];
      const sourceVersionId = await getOrCreateSourceVersion(this.env.DB, sourceId, versionDate, canonicalName);

      // Cache the root page
      await this.env.STORAGE.put(
        `sources/cga/${versionId}/titles.htm`,
        html,
        { httpMetadata: { contentType: 'text/html' } },
      );

      // Insert root node
      const accessedAt = new Date().toISOString();
      const rootNodeId = await insertNode(this.env.DB, sourceVersionId, 'cgs/root', null, 'root', -1, 0, 'Connecticut General Statutes', '/statutes/cgs', 'CGS', 'CGS', null, startUrl, accessedAt);

      // Extract title URLs
      const titleUrls = extractTitleUrls(html, startUrl);

      return {
        sourceVersionId,
        versionId,
        canonicalName,
        rootNodeId,
        titleUrls,
      };
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Titles - process each title page in parallel
    // ═══════════════════════════════════════════════════════════════
    const titleResults: TitleStepOutput[] = [];

    for (const titleUrl of root.titleUrls) {
      const titleResult = await step.do(
        `title-${extractFilename(titleUrl)}`,
        async (): Promise<TitleStepOutput> => {
          const { body } = await fetchWithCache(
            titleUrl,
            root.versionId,
            this.env.STORAGE,
          );

          const parsed = await parseTitlePage(body, titleUrl);
          const accessedAt = new Date().toISOString();

          // Insert title node
          const titleNodeId = await insertNode(
            this.env.DB,
            root.sourceVersionId,
            `cgs/title/${parsed.titleId}`,
            root.rootNodeId,
            'title',
            0,
            designatorSortOrder(parsed.titleId),
            parsed.titleName || `Title ${parsed.titleId}`,
            `/statutes/cgs/title/${parsed.titleId}`,
            parsed.titleId,
            `Title ${parsed.titleId}`,
            null,
            titleUrl,
            accessedAt,
          );

          return {
            titleNodeId,
            titleId: parsed.titleId,
            chapterUrls: parsed.chapterUrls,
          };
        },
      );

      titleResults.push(titleResult);
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Chapters - process in batches of 20
    // ═══════════════════════════════════════════════════════════════
    const chapterResults: ChapterStepOutput[] = [];

    // Build chapter batches: group chapters with their parent title info
    const CHAPTER_BATCH_SIZE = 20;
    const chapterBatches: ChapterBatch[] = [];

    for (const title of titleResults) {
      for (let i = 0; i < title.chapterUrls.length; i += CHAPTER_BATCH_SIZE) {
        chapterBatches.push({
          titleNodeId: title.titleNodeId,
          titleId: title.titleId,
          chapters: title.chapterUrls.slice(i, i + CHAPTER_BATCH_SIZE),
        });
      }
    }

    for (let batchIndex = 0; batchIndex < chapterBatches.length; batchIndex++) {
      const batch = chapterBatches[batchIndex];

      const batchResults = await step.do(
        `chapters-batch-${batchIndex}`,
        async (): Promise<ChapterStepOutput[]> => {
          const results: ChapterStepOutput[] = [];

          for (const chapter of batch.chapters) {
            const { body } = await fetchWithCache(
              chapter.url,
              root.versionId,
              this.env.STORAGE,
            );

            const parsed = await parseChapterPage(body, chapter.url, chapter.type);
            const accessedAt = new Date().toISOString();
            const chapterType = chapter.type.charAt(0).toUpperCase() + chapter.type.slice(1);

            // Insert chapter node
            const chapterNodeId = await insertNode(
              this.env.DB,
              root.sourceVersionId,
              `cgs/${chapter.type}/${parsed.chapterId}`,
              batch.titleNodeId,
              chapter.type,
              1,
              designatorSortOrder(parsed.chapterId),
              parsed.chapterTitle,
              `/statutes/cgs/${chapter.type}/${batch.titleId}/${parsed.chapterId}`,
              parsed.chapterId,
              `${chapterType} ${parsed.chapterId}`,
              null,
              chapter.url,
              accessedAt,
            );

            // Create section batches as index ranges
            const totalSections = parsed.sectionCount;
            const sectionBatches: SectionBatch[] = [];
            for (let i = 0; i < totalSections; i += 200) {
              sectionBatches.push({
                startIndex: i,
                endIndex: Math.min(i + 200, totalSections),
              });
            }

            results.push({
              chapterNodeId,
              chapterId: parsed.chapterId,
              chapterUrl: chapter.url,
              totalSections,
              sectionBatches,
            });
          }

          return results;
        },
      );

      chapterResults.push(...batchResults);
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Sections - fetch from cache, parse range, insert
    // ═══════════════════════════════════════════════════════════════
    const blobStore = new BlobStore(
      this.env.DB,
      this.env.STORAGE,
      await getSourceId(this.env.DB, 'cgs'),
      'cgs',
    );

    let totalSectionsInserted = 0;

    for (const chapter of chapterResults) {
      for (let batchIndex = 0; batchIndex < chapter.sectionBatches.length; batchIndex++) {
        const batch = chapter.sectionBatches[batchIndex];

        const result = await step.do(
          `sections-${chapter.chapterId}-batch-${batchIndex}`,
          async () => {
            // Fetch chapter HTML from R2 cache
            const r2Key = `sources/cga/${root.versionId}/${extractFilename(chapter.chapterUrl)}`;
            const cached = await this.env.STORAGE.get(r2Key);
            if (!cached) {
              throw new Error(`Chapter HTML not found in cache: ${r2Key}`);
            }

            // Parse only sections in this batch's range
            const html = await cached.text();
            const sections = await parseSectionsInRange(
              html,
              chapter.chapterUrl,
              batch.startIndex,
              batch.endIndex,
            );

            const accessedAt = new Date().toISOString();
            const nodes: NodeInsert[] = [];

            for (let i = 0; i < sections.length; i++) {
              const section = sections[i];

              // Build content blob
              const content = buildSectionContent(section);
              const blobHash = await blobStore.storeJson(content);

              nodes.push({
                source_version_id: root.sourceVersionId,
                string_id: section.stringId,
                parent_id: chapter.chapterNodeId,
                level_name: 'section',
                level_index: 2,
                sort_order: batch.startIndex + i,
                name: section.name,
                path: section.path,
                readable_id: section.readableId,
                heading_citation: section.readableId ? `CGS § ${section.readableId}` : null,
                blob_hash: blobHash,
                source_url: chapter.chapterUrl,
                accessed_at: accessedAt,
              });
            }

            await insertNodesBatched(this.env.DB, nodes);

            return { insertedCount: nodes.length };
          },
        );

        totalSectionsInserted += result.insertedCount;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Finalize - flush blobs, set root node
    // ═══════════════════════════════════════════════════════════════
    await step.do('finalize', async () => {
      await blobStore.flush();
      await setRootNodeId(this.env.DB, root.sourceVersionId, root.rootNodeId);

      return {
        sourceVersionId: root.sourceVersionId,
        canonicalName: root.canonicalName,
        titlesProcessed: titleResults.length,
        chaptersProcessed: chapterResults.length,
        sectionsInserted: totalSectionsInserted,
      };
    });
  }
}
```

## Helper Functions

```typescript
// packages/ingest/src/lib/cga/workflow-helpers.ts

/**
 * Extract the revision year from CGA HTML
 * Matches patterns like "Revised to January 1, 2025"
 */
export function extractVersionId(html: string): string {
  const patterns = [
    /revised\s+to\s+\w+\s+\d+,?\s+(\d{4})/i,
    /current\s+through\s+.*?(\d{4})/i,
    /as\s+of\s+.*?(\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1]; // Returns just the year, e.g., "2025"
    }
  }

  // Fallback to current year
  return new Date().getFullYear().toString();
}

/**
 * Extract filename from URL for R2 key construction
 */
export function extractFilename(url: string): string {
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/');
  return parts[parts.length - 1] || 'index.htm';
}

/**
 * Extract title page URLs from the root titles.htm page
 */
export function extractTitleUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const linkPattern = /href=["']([^"']*title_[^"']+\.htm)["']/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const absoluteUrl = new URL(match[1], baseUrl).toString();
    if (!urls.includes(absoluteUrl)) {
      urls.push(absoluteUrl);
    }
  }

  return urls;
}

/**
 * Parse chapter page - returns chapter info and section count (not full sections)
 * Used by chapter step to determine batching
 */
export async function parseChapterPage(
  body: ReadableStream,
  url: string,
  type: 'chapter' | 'article',
): Promise<{
  chapterId: string;
  chapterTitle: string | null;
  sectionCount: number;
}> {
  const parser = new ChapterParser();
  await parser.parse(body);

  return {
    chapterId: parser.getChapterNumber() || extractChapterIdFromUrl(url),
    chapterTitle: parser.getChapterTitle(),
    sectionCount: parser.getSections().length,
  };
}

/**
 * Parse sections in a specific index range from chapter HTML
 * Used by section batch steps to parse only their assigned sections
 */
export async function parseSectionsInRange(
  html: string,
  sourceUrl: string,
  startIndex: number,
  endIndex: number,
): Promise<ParsedSection[]> {
  const parser = new ChapterParser();
  await parser.parse(html);

  const allSections = parser.getSections();
  const chapterId = parser.getChapterNumber() || '';

  // Build ParsedSection objects for the requested range
  return buildSectionsFromParsedData(
    allSections.slice(startIndex, endIndex),
    parser.getSectionLabels(),
    chapterId,
    sourceUrl,
    'chapter', // or detect from URL
  );
}
```

## Triggering the Workflow

### API Endpoint

```typescript
// packages/ingest/src/worker.ts (updated)

app.post('/api/ingest/cga/workflow', async (c) => {
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({}));

  const instance = await c.env.CGA_WORKFLOW.create({
    id: `cga-${Date.now()}`,
    params: { force },
  });

  return c.json({
    instanceId: instance.id,
    status: await instance.status(),
  });
});

app.get('/api/ingest/cga/workflow/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');
  const instance = await c.env.CGA_WORKFLOW.get(instanceId);

  return c.json({
    instanceId: instance.id,
    status: await instance.status(),
  });
});
```

## Error Handling & Retry Strategy

### Step-Level Retries

Cloudflare Workflows automatically retries failed steps with exponential backoff. For CGA-specific handling:

```typescript
// In workflow step
const result = await step.do('fetch-chapter', {
  retries: {
    limit: 3,
    delay: '10 seconds',
    backoff: 'exponential',
  },
}, async () => {
  // Fetch logic
});
```

### Idempotency Checks

Each step should be idempotent:

1. **Node insertion**: Use `INSERT OR IGNORE` or check for existing `string_id`
2. **Blob storage**: Hash-based deduplication already handles this
3. **R2 caching**: Overwriting is idempotent

```typescript
// Idempotent node insertion
export async function insertNodeIdempotent(
  db: D1Database,
  node: NodeInsert,
): Promise<number> {
  // Try to find existing
  const existing = await db.prepare(`
    SELECT id FROM nodes
    WHERE string_id = ? AND source_version_id = ?
  `).bind(node.string_id, node.source_version_id).first<{ id: number }>();

  if (existing) {
    return existing.id;
  }

  // Insert new
  const result = await db.prepare(`
    INSERT INTO nodes (...)
    VALUES (...)
    RETURNING id
  `).bind(...).first<{ id: number }>();

  return result!.id;
}
```

## Limits & Considerations

| Constraint | Limit | Mitigation |
|------------|-------|------------|
| Concurrent instances | 10,000 | CGA has ~100 titles, well under limit |
| Step return size | 1 MiB | Chapter batches of 20 and section batches of 200 stay under this |
| Step timeout | 30 min | Individual page fetches are fast |
| Instance creation rate | 100/sec | We create one workflow, not many |

## Observability

### Metrics to Track

1. **Per-step timing**: Workflows provides this automatically
2. **Cache hit rate**: Log in `fetchWithCache`
3. **Section counts**: Return from each step
4. **Error rates**: Workflow dashboard shows failures

### Logging

```typescript
// Structured logging in steps
console.log(JSON.stringify({
  event: 'chapter_processed',
  chapterId: result.chapterId,
  sectionCount: result.sectionBatches.flat().length,
  cached: cached,
  durationMs: Date.now() - startTime,
}));
```

## Testing Strategy

### Local Development

```bash
# Run with wrangler dev
wrangler dev --test-scheduled

# Trigger workflow locally
curl -X POST http://localhost:8787/api/ingest/cga/workflow
```

### Integration Tests

```typescript
// packages/ingest/src/lib/cga/workflow.test.ts
import { createWorkflowMock } from 'cloudflare:test';

describe('CGAIngestWorkflow', () => {
  it('extracts version ID from HTML', () => {
    const html = '<p>Revised to January 1, 2025</p>';
    expect(extractVersionId(html)).toBe('2025');
  });

  it('batches sections correctly', () => {
    const sections = Array.from({ length: 450 }, (_, i) => ({ id: i }));
    const batches = batchSections(sections, 200);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(200);
    expect(batches[1]).toHaveLength(200);
    expect(batches[2]).toHaveLength(50);
  });
});
```

## Rollout Plan

1. **Phase 1**: Add migration, deploy without workflow binding
2. **Phase 2**: Add workflow class, test locally with `wrangler dev`
3. **Phase 3**: Deploy workflow, test with `force=true` on existing data
4. **Phase 4**: Remove old `ingestCGA` function, update API endpoint
5. **Phase 5**: Add monitoring dashboard

## Future Enhancements

1. **Incremental updates**: Compare cached HTML hashes to detect changes
2. **Parallel title processing**: Use `Promise.all` within steps for titles (currently sequential for simplicity)
3. **Cross-reference resolution**: Add a final step to resolve section cross-references
4. **Diff computation**: Integrate with existing `computeDiff` after all sections inserted
