# Rust RIGL Guide

This directory holds Rhode Island General Laws ingest logic.

- Keep RIGL-specific discover, adapter, and parser behavior here.
- Preserve deterministic output and test-backed parsing behavior.
- Validate against the RIGL tests before considering refactors complete.

## Files

- `adapter.rs`: RIGL adapter entrypoint.
- `discover.rs`: RIGL discovery logic.
- `mod.rs`: RIGL module exports.
- `parser.rs`: RIGL parser implementation.
