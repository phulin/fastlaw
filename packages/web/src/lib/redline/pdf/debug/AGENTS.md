# PDF Debug Guide

This directory holds debug-only helpers for inspecting PDF pipeline state.

- Keep formatting and inspection helpers here.
- Do not let debug utilities become production decision-making logic.
- If a debug helper changes a semantic assumption, inspect the processing layer too.

## Files

- `formatters.ts`: debug formatting helpers for PDF pipeline state.
