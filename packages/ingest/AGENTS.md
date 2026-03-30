# Ingest Package Guide

This guide covers `packages/ingest`: ingest workers, jurisdiction adapters, packfile logic, and the Rust container boundary.

## Directory Map

- `src/lib/ingest`: core ingest flow.
- `src/lib/cga`, `src/lib/mgl`: jurisdiction-specific logic.
- `src/lib/packfile`: blob and packfile handling.
- `src/lib/vector`: vector-related utilities.
- `container-rust`: Rust-side parsing/runtime code.
- `src/__tests__`: ingest fixtures and tests.

## Local Invariants

- Prefer deterministic IDs and deterministic output ordering.
- Batch operations instead of writing node-by-node.
- Keep adapters explicit. Do not add abstractions unless they remove real duplication.
- Respect the TypeScript/Rust boundary. Do not move logic across it casually.

## Task Routing

- If adding or changing a jurisdiction adapter, read `../../docs/agents/ingest-jurisdiction.md`.
- If changing workflow, retry, caching, or long-running execution behavior, read `../../docs/agents/cloudflare-workflows.md`.
- If the change affects schema or shared persistence expectations, also read `../../docs/agents/schema-and-migrations.md`.

## Verification

- Package test command: `yarn workspace @fastlaw/ingest test`
- Repo-wide verification: `yarn check:fix && yarn typecheck`
- Ingest typecheck also runs `cargo check`.

## References

- Use `../../docs/design/generic-workflows.md` for the generalized ingest architecture.
- Use `../../docs/design/cga-workflows.md` for Cloudflare workflow-specific design notes.
