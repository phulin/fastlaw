# Rust VT Guide

This directory holds Vermont ingest logic.

- Keep VT-specific discover, adapter, and parser behavior here.
- Preserve deterministic output and test-backed parsing behavior.
- Validate against the VT tests before considering refactors complete.

## Files

- `adapter.rs`: VT adapter entrypoint.
- `discover.rs`: VT discovery logic.
- `mod.rs`: VT module exports.
- `parser.rs`: VT parser implementation.
