# Amendment Parser Guide

This directory holds the grammar-backed instruction parser and parser entrypoints.

- Keep parser concerns here: grammar loading, parsing, and syntax-level helpers.
- Preserve deterministic span consumption and parse anchoring behavior.
- Parser changes need parser-focused tests.
- Read `../../../../../../docs/agents/redline-pipeline.md` before editing.

## Files

- `create-handcrafted-instruction-parser.ts`: parser factory that loads the grammar-backed parser.
- `handcrafted-instruction-parser.ts`: main handcrafted parser implementation.
- `markdown-hierarchy-parser.ts`: parses markdown-like hierarchy structures used by instruction handling.
