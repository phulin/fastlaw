# Container Rust Source Guide

This directory holds the Rust runtime entrypoints and top-level modules for ingest container work.

- Keep runtime wiring here.
- Shared runtime concerns live in `runtime/`.
- Jurisdiction implementations live in `sources/`.
- When changing semantics, inspect the matching test directory under `../tests`.

## Files

- `bench_parser.rs`: parser benchmarking entrypoint or harness.
- `dummy.rs`: placeholder or stub runtime implementation.
- `explore.rs`: exploratory utilities for inspecting source behavior.
- `ingest.rs`: ingest runtime wiring or entry helpers.
- `lib.rs`: crate library entrypoint.
- `main.rs`: binary entrypoint for the container runtime.
- `types.rs`: shared Rust-side types.
