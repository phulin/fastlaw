# Design Doc: Containerized USC/CGA Ingestion

## Overview
Move USC and CGA ingestion into a single Cloudflare Container image. Each Worker endpoint request starts a fresh container instance, forwards the request, and waits for progress updates until completion. The container uses HTTP APIs for D1 and R2 with credentials injected via env vars.

## Goals
- One container image for USC + CGA ingestion.
- One container instance per request.
- Worker-triggered via existing endpoints.
- Container uses D1 HTTP API and R2 S3 API via env vars (no bindings).
- Worker waits for progress and returns completion result.

## Non-Goals
- Multi-instance parallel ingestion in a single request.
- Persistent container disks.
- Refactoring ingestion logic beyond interface adapters.

## Current State
- `packages/ingest/src/worker.ts` calls `ingestUSC`/`ingestCGA` directly.
- `ingestUSC`/`ingestCGA` depend on `Env` bindings for D1 and R2.
- D1 and R2 are available as bindings only inside Workers.

## Proposed Architecture
1. Worker receives `POST /api/ingest/usc` or `POST /api/ingest/cga`.
2. Worker creates a `jobId` and inserts a row in `ingest_jobs` (D1).
3. Worker starts a container instance and passes `{ jobId, source }`.
4. Container runs ingestion logic using HTTP API adapters for D1 and R2.
5. Container posts progress events to a Progress Durable Object (DO) via the Worker.
6. Clients connect to `GET /api/ingest/jobs/:id/events` (SSE) served by the Progress DO.
7. Progress DO writes state snapshots to `ingest_jobs` in D1.
8. Worker returns completion based on job status or returns `jobId` immediately.

## Progress Mechanism (Decision)
Use a Progress Durable Object for live SSE and D1 persistence.

### How it works
- Container emits progress events to the Worker endpoint `POST /api/ingest/jobs/:id/progress`.
- Worker routes to a Progress DO instance keyed by `jobId`.
- DO maintains in-memory state + short event buffer for SSE.
- DO persists progress snapshots to D1 `ingest_jobs` (status, progress, message).
- Clients connect to `GET /api/ingest/jobs/:id/events` for SSE.

### Why
- Avoids polling and client tables in D1.
- Supports multiple clients watching the same job.
- Keeps Worker runtime short; DO handles streaming.

## Data Access from Container
### D1
- Use D1 HTTP API with a Cloudflare API token.
- Provide `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_API_TOKEN` env vars.
- Implement minimal SQL client for prepared statements, batch inserts, and queries.

### R2
- Use S3-compatible API endpoint.
- Provide `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.
- Use AWS SDK v3 `@aws-sdk/client-s3`.
- Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

## API/Schema Changes
### New D1 table: `ingest_jobs`
Fields:
- `id` (UUID, primary key)
- `source` (TEXT: `usc`/`cga`)
- `status` (TEXT: `queued`/`running`/`succeeded`/`failed`)
- `progress` (INTEGER 0-100)
- `message` (TEXT)
- `started_at`, `updated_at`, `finished_at`
- `result_json` (TEXT)
- `error_json` (TEXT)

### Worker endpoints
- `POST /api/ingest/usc` and `/api/ingest/cga`
  - Create `ingest_jobs` row in `queued`.
  - Start container, pass `jobId` and `source`.
  - Return `jobId` immediately.

- `POST /api/ingest/jobs/:id/progress`
  - Accepts progress events from the container.
  - Routes to Progress DO instance for `jobId`.

- `GET /api/ingest/jobs/:id/events`
  - SSE endpoint from Progress DO.
  - Streams progress events and terminal status.

- `GET /api/ingest/jobs/:id`
  - Returns current status from `ingest_jobs` (D1).

### Container HTTP API
- `POST /ingest/usc`
- `POST /ingest/cga`
- Body includes `jobId` and optional parameters.
- Container posts progress to `POST /api/ingest/jobs/:id/progress`.

## Code Changes (High-Level)
### New container server
- Add `packages/ingest/src/container-server.ts`:
  - HTTP server with two endpoints.
  - Bootstraps ingestion with HTTP adapters.

### HTTP adapters
- Add `packages/ingest/src/lib/http/d1.ts`:
  - `prepare`, `run`, `all`, `exec`, `batch` backed by D1 SQL API.
- Add `packages/ingest/src/lib/http/r2.ts`:
  - `get`, `put`, `list` via S3 API.

### Env split
- Add `ContainerEnv` type with HTTP credentials.
- Refactor ingestion functions to accept interfaces:
  - `DatabaseClient` (D1 binding or HTTP)
  - `ObjectStore` (R2 binding or HTTP)

### Worker changes
- In `packages/ingest/src/worker.ts`:
  - Replace direct ingest call with container invocation.
  - Create `ingest_jobs` row on start.
  - Add Progress DO routes (SSE + progress ingest).

### Wrangler config
- Add `[[containers]]` with image path.
- Add `[[durable_objects.bindings]]` and migrations for container class.
- Add `[[durable_objects.bindings]]` for `ProgressDO`.
- Add secrets for D1/R2 credentials.

## Container Image
- Single image with Node runtime.
- `Dockerfile` uses `node:20` or Cloudflare base.
- Bundles TypeScript build output.
- Exposes one port (e.g., `8080`).

## Credentials Needed (Cloudflare UI)
### D1 HTTP API
- API Token with `Account > D1 > Edit`.
- D1 database ID for `fastlaw`.
- Cloudflare Account ID.

### R2 S3 API
- R2 API token with read/write to the bucket (or bucket-scoped token).
- Access Key ID and Secret Access Key from the token.
- Bucket name `fastlaw-content`.
- Cloudflare Account ID.

## Operational Considerations
- Rate limits on D1 SQL API; implement retries and batching.
- Large ingest may exceed Worker request duration; return `jobId` and use SSE for progress.
- Persist snapshots to D1 to survive DO restarts.

## Open Questions
1. None (decisions finalized for v1).
