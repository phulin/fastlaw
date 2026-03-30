# Rust USPL Guide

This directory holds U.S. Public Laws ingest logic.

- Keep USPL-specific discover, parser, and markdown handling here.
- Preserve deterministic parsing and fixture-backed expectations.
- Validate against the USPL tests before considering refactors complete.

## Files

- `adapter.rs`: USPL adapter entrypoint.
- `discover.rs`: USPL discovery logic.
- `markdown.rs`: USPL markdown processing helpers.
- `mod.rs`: USPL module exports.
- `parser.rs`: USPL parser implementation.
