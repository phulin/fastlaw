# Rust NH Guide

This directory holds New Hampshire ingest logic.

- Keep NH-specific discover, adapter, and parser behavior here.
- Preserve deterministic output and test-backed parsing behavior.
- Validate against the NH tests before considering refactors complete.

## Files

- `adapter.rs`: NH adapter entrypoint.
- `discover.rs`: NH discovery logic.
- `mod.rs`: NH module exports.
- `parser.rs`: NH parser implementation.
