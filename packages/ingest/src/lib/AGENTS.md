# Ingest Lib Guide

This directory holds TypeScript-side ingest internals: job wiring, containers, packfile DO plumbing, versioning, and shared utilities.

- Keep ingest runtime logic here.
- Jurisdiction-specific logic belongs in the matching subdirectory.
- Respect batching, determinism, and idempotency constraints.
- Read `../../../../docs/agents/ingest-jurisdiction.md` or `../../../../docs/agents/cloudflare-workflows.md` when the task matches.

## Files

- `callback-auth.ts`: callback authentication helpers for ingest runtime communication.
- `ingest-container.ts`: wrapper logic for launching or talking to the ingest container.
- `ingest-jobs.ts`: ingest job creation and tracking helpers.
- `packfile-do.ts`: Durable Object integration for packfile handling.
- `sources-config.ts`: source configuration definitions and lookup helpers.
- `streaming.ts`: streaming helpers for ingest data flow.
- `versioning.ts`: source versioning helpers.
- `zip-utils.ts`: utilities for working with zip-based sources.
