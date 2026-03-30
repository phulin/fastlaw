# Container Rust Tests Guide

This directory holds integration-style Rust tests for container-side ingest behavior.

- Keep top-level test wiring and per-jurisdiction suites here.
- Prefer fixture-backed assertions over synthetic unit coverage when behavior depends on real source structure.
- Mirror source changes with the matching jurisdiction test directory.

## Files

- `cgs_tests.rs`: top-level CGS test wiring.
- `configs.rs`: shared test configuration helpers.
- `logging_macros.rs`: tests or helpers for logging macros.
- `mgl_tests.rs`: top-level MGL test wiring.
- `nh_tests.rs`: top-level NH test wiring.
- `rigl_tests.rs`: top-level RIGL test wiring.
- `usc_tests.rs`: top-level USC test wiring.
- `uspl_tests.rs`: top-level USPL test wiring.
- `vt_tests.rs`: top-level VT test wiring.
