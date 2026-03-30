# Rust CGS Guide

This directory holds Connecticut General Statutes Rust ingest logic.

- Keep CGS-specific discover, adapter, parser, and cross-reference behavior here.
- Preserve deterministic structure and fixture-backed expectations.
- Validate against the CGS tests before considering refactors complete.

## Files

- `adapter.rs`: CGS adapter entrypoint.
- `cross_references.rs`: CGS cross-reference handling.
- `discover.rs`: CGS discovery logic.
- `mod.rs`: CGS module exports.
- `parser.rs`: CGS parser implementation.
