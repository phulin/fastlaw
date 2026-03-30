# Server Guide

This directory holds server-side web logic.

- Keep server-only logic here rather than in UI components.
- Check Worker/runtime constraints before moving shared code into this directory.
- If the change crosses browser/server boundaries, read `../../../../docs/agents/web-runtime-boundaries.md`.

## Files

- `search.ts`: server-side search logic and request handling.
