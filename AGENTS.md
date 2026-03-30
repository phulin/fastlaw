# Agent Guide

`fast.law` is a monorepo with two main systems: a web app that includes the PDF redline pipeline, and an ingest system for building structured legal corpora. Start here, then read the nearest package guide before making changes.

## Global Rules

- Use `yarn` for package management.
- Write everything in TypeScript, including one-time throwaway scripts.
- Avoid defensive programming. Prefer type-driven guarantees and simple control flow.
- Do not preserve backward compatibility inside the repo if a cleaner refactor updates all callsites.
- Ask questions if the request is unclear.
- There may be multiple agents working at once. Ignore unrelated changes.
- Do not re-export types imported from library packages. Import them directly where used.

## Required Verification

- After making edits, run `yarn check:fix && yarn typecheck`.
- To run tests, use `yarn workspace @fastlaw/xxx test`.

## Repo Map

- `packages/web`: UI, routes, worker/server code, PDF redline pipeline.
- `packages/ingest`: ingest workers, jurisdiction adapters, packfile logic, Rust container integration.
- `packages/db`: migrations and schema-level changes.
- `docs/agents`: task-specific guides. Read these when a package guide tells you to.
- `docs/design`: deep reference docs. Do not load these by default.

## Routing

- If touching UI, routes, worker endpoints, or generic web code, read `packages/web/AGENTS.md`.
- If touching redline parsing, PDF processing, or amendment application semantics, read `packages/web/AGENTS.md` and then the relevant guide in `docs/agents/`.
- If touching ingest pipelines, scraper logic, or Cloudflare workflow behavior, read `packages/ingest/AGENTS.md`.
- If touching schema or migrations, read `packages/db/AGENTS.md`.

## Reading Discipline

- Start with the nearest relevant guide.
- Only read deeper `docs/agents/*` files when the task matches that workflow.
- Only read `docs/design/*` when a task guide points there for rationale or edge cases.

## AGENTS Maintenance

- When you add, remove, rename, or substantially repurpose files in a directory that has an `AGENTS.md`, update that directory's `AGENTS.md` in the same change.
- Keep file summaries short and factual.
- If a change alters routing, ownership boundaries, or where logic is expected to live, update the nearest parent `AGENTS.md` too.
