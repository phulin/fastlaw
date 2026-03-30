# Packfile Guide

This directory holds packfile hashing, storage, and writer logic.

- Keep blob and archive concerns here.
- Be careful with format changes because they affect ingest persistence behavior broadly.
- Validate both writer behavior and downstream reads when changing formats.

## Files

- `hash.ts`: hashing helpers for packfile content or layout.
- `index.ts`: packfile public exports.
- `store.ts`: persistence helpers for packfile storage.
- `tar.ts`: tar-format helpers for packfile assembly.
- `writer.ts`: packfile writer implementation.
