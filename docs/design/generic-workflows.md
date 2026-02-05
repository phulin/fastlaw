# Generic Statute Ingestion System

**Design Document (Revised)**

## 1. Goals and Non-Goals

### Goals

* Support jurisdictions with **arbitrary hierarchy depth**
* Support both:

  * **monolithic sources** (entire titles in one file)
  * **highly fragmented sources** (one file per section)
* Use **deterministic textual IDs** to encode hierarchy
* Perform **one global tree walk per top-level unit**
* Batch inserts efficiently into:

  * relational metadata store
  * blob/object storage
* Respect Cloudflare limits:

  * 1000 subrequests
  * 128 MB memory
* Make ingestion:

  * idempotent
  * retry-safe
  * resumable

### Non-Goals

* Enforcing temporal “parent finishes before child” execution ordering
* Database-generated IDs
* Transactional guarantees across the entire tree
* Fine-grained workflow coordination between nodes

---

## 2. Core Design Principles

1. **Hierarchy is encoded in IDs, not enforced by execution**
2. **IDs are deterministic, textual, and prefix-based**
3. **Tree discovery is global and read-only**
4. **Insertion is batched and idempotent**
5. **Existence checks happen before writes**
6. **Execution shape is independent of hierarchy shape**

---

## 3. Canonical Identifier Scheme

### ID format

```
<source>/<version>/root/<level0>/<level1>/.../<levelN>
```

### Examples

```
cgs/2025/root
cgs/2025/root/title-12
cgs/2025/root/title-12/chapter-3
cgs/2025/root/title-12/chapter-3/section-45
```

### Properties

* Globally unique
* Human-readable
* Deterministic across retries
* Computable *before* any DB or blob operation
* Parent ID is always a strict prefix of child ID

### Invariants

* IDs are never mutated once published
* Structural changes result in new IDs (new version or new path)

---

## 4. Data Model

### Nodes table (metadata)

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,          -- hierarchical textual ID
  source TEXT,                  -- e.g. "cgs"
  version TEXT,                 -- e.g. "2025"
  kind TEXT,                    -- title | chapter | section | …
  label TEXT,                   -- display label
  path TEXT,                    -- serialized path segments
  body_ref TEXT,                -- blob key (NULL for non-leaf)
  created_at INTEGER
);
```

### Notes

* No foreign keys required
* Parent-child relationships are inferred via ID prefix
* Inserts are always `ON CONFLICT DO NOTHING`

---

## 5. High-Level Execution Architecture

```
JurisdictionWorkflow
  └── UnitWorkflow (one per top-level unit, e.g. title)
        ├── global tree walk
        ├── shard planning
        └── batched inserts (DB + blob store)
```

Key change:

> **No workflow is created per chapter or section.**
> The entire hierarchy under a unit is discovered in one pass.

---

## 6. Jurisdiction Adapter Interface

Adapters describe **how to walk the tree**, not how to insert or batch.

```ts
interface TocNode {
  id: string                 // hierarchical ID
  kind: string               // title, chapter, section, …
  label: string
  url?: string               // fetchable source, if any
  children?: TocNode[]
}

interface JurisdictionAdapter {
  source: string             // e.g. "cgs"
  version: string            // e.g. "2025"

  discoverUnitRoots(): Promise<TocNode[]>
  expand(node: TocNode): Promise<TocNode[]>
  shardify(node: TocNode): Promise<Shard[]>
}
```

---

## 7. Global Tree Walk (per Unit)

For each top-level unit (e.g. a title):

1. Start from the unit root
2. Recursively expand nodes
3. Materialize the **entire logical tree in memory**
4. Emit a flat list of nodes and leaf shards

This walk is:

* read-only
* deterministic
* retryable
* isolated per unit

If a unit is too large to walk safely:

* it is split at the *unit level* (e.g. multiple titles)
* not at arbitrary hierarchy levels

---

## 8. Shard Model

A shard represents one fetch + parse + blob write.

```ts
interface Shard {
  nodeId: string             // same as node.id
  fetch: {
    url: string
    range?: [number, number]
  }
  bodyRef: string            // deterministic blob key
  meta: {
    kind: string
    label: string
    path: string[]
  }
}
```

---

## 9. Insertion Strategy (Key Change)

### No parent-before-child constraint

The system **does not require** parent nodes to be inserted before children.

Correctness is guaranteed because:

* IDs encode full ancestry
* All inserts are idempotent
* Parent existence is implied, not enforced

---

## 10. Batched Insert Pipeline

For each unit:

### Step 1: Global planning

* Walk full tree
* Produce:

  * `nodes[]` (metadata)
  * `shards[]` (leaf content)

### Step 2: Database insertion (metadata)

1. Partition `nodes[]` into batches (e.g. 200–500 rows)
2. For each batch:

   * `SELECT id FROM nodes WHERE id IN (…)`
   * Filter out existing IDs
   * `INSERT` remaining rows with `ON CONFLICT DO NOTHING`

This avoids:

* redundant writes
* large single statements
* SQLite size limits

---

### Step 3: Blob store insertion (content)

For each shard batch:

1. Check existence via metadata or blob HEAD
2. Skip existing blobs
3. Fetch + parse
4. Write blob using existing blob-store code
5. Update `body_ref` if needed (idempotent)

Batching rules:

* One batch per blob store operation
* Independent retry per batch
* No cross-batch coordination

---

## 11. Failure and Retry Semantics

### Properties

* Safe to retry entire unit
* Safe to retry individual batches
* Safe to re-run ingestion for same version

### Failure scenarios

| Failure                | Outcome                           |
| ---------------------- | --------------------------------- |
| Crash during tree walk | No side effects                   |
| Crash mid-DB batch     | Batch retried, duplicates ignored |
| Crash mid-blob batch   | Blob existence check skips        |
| Partial ingestion      | Next run resumes naturally        |

---

## 12. Why This Design Works

### Why a single global walk?

* Simplifies reasoning
* Makes sharding deterministic
* Eliminates partial hierarchy state
* Avoids workflow explosion

### Why textual IDs?

* No DB round-trips for IDs
* Natural prefix hierarchy
* Cheap existence checks
* Excellent debuggability

### Why no parent ordering?

* Ordering is encoded structurally
* Temporal constraints add fragility
* Idempotency + determinism are stronger guarantees

---

## 13. Design Invariants

These must not be violated:

1. IDs are computed, never generated
2. IDs fully encode hierarchy
3. Tree walk is read-only
4. Inserts are batched and idempotent
5. Blob writes are existence-checked
6. No workflow per hierarchy node

---

## 14. Summary

This revised system:

* Treats statute ingestion as **tree planning + batch execution**
* Uses IDs as the sole source of truth for hierarchy
* Avoids unnecessary ordering constraints
* Scales to deep and wide hierarchies
* Maps cleanly onto Cloudflare Workers + Workflows
