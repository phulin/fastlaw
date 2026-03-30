# Cloudflare Workflows Guide

## When To Read

- workflow entrypoint changes
- retry or idempotency changes
- R2 or cache strategy changes
- long-running ingest execution refactors

## Operational Constraints

- retries must be safe
- execution must stay resumable
- cache keys and version identifiers must stay deterministic
- workflow shape should respect platform limits and keep memory bounded

## Invariants

- Execution shape should not redefine hierarchy semantics.
- Workflow retries must not create duplicate logical output.
- Cache and source-version paths should remain predictable and inspectable.

## Deep References

- Use `../design/generic-workflows.md` for the general ingest workflow model.
- Use `../design/cga-workflows.md` for the current CGA workflow design and caching approach.
