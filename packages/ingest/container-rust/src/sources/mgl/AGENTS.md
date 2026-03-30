# Rust MGL Guide

This directory holds Massachusetts General Laws Rust ingest logic.

- Keep MGL-specific discover, adapter, parser, and cross-reference behavior here.
- Preserve deterministic output and fixture-backed expectations.
- Validate against the MGL tests before considering refactors complete.

## Files

- `adapter.rs`: MGL adapter entrypoint.
- `cross_references.rs`: MGL cross-reference handling.
- `discover.rs`: MGL discovery logic.
- `mod.rs`: MGL module exports.
- `parser.rs`: MGL parser implementation.
