# Ingest Types Guide

This directory holds package-specific type declarations.

- Keep declarations minimal and clearly package-scoped.
- Do not re-export library types from here.
- Prefer colocated types when a type is not actually shared.

## Files

- `yaml.d.ts`: type declarations for YAML module imports.
