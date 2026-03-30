# Rust USC Guide

This directory holds United States Code ingest logic.

- Keep USC-specific discover, adapter, parser, and cross-reference behavior here.
- Be careful with structural or citation changes because they ripple widely.
- Validate against the USC tests before considering refactors complete.

## Files

- `adapter.rs`: USC adapter entrypoint.
- `cross_references.rs`: USC cross-reference handling.
- `discover.rs`: USC discovery logic.
- `mod.rs`: USC module exports.
- `parser.rs`: USC parser implementation.
