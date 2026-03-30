# Rust Sources Guide

This directory holds jurisdiction-specific Rust ingest implementations plus shared source-level config.

- Keep shared source helpers in this directory root.
- Put jurisdiction behavior in the matching subdirectory.
- When changing shared source code, inspect impact across multiple jurisdictions and tests.

## Files

- `common.rs`: shared source-level helpers used across jurisdictions.
- `configs.rs`: source configuration definitions.
- `mod.rs`: source module exports and registration.
