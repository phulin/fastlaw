# Ingest Source Root Guide

This directory holds the ingest Worker entrypoints and top-level source types.

- `worker.ts` is the main Worker entrypoint.
- `index.ts` and top-level types wire package-level exports and runtime entry.
- Deeper ingest logic belongs under `lib/`.
- Read `../lib/AGENTS.md` for internal ingest behavior.

## Files

- `index.ts`: top-level package entrypoint for ingest exports.
- `types.ts`: top-level ingest package types.
- `worker.ts`: Cloudflare Worker entrypoint for the ingest package.
