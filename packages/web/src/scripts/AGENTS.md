# Scripts Guide

This directory holds one-off or developer-facing scripts for benchmarking, comparison, and pipeline inspection.

- Keep scripts task-specific and disposable.
- Write scripts in TypeScript.
- Prefer importing existing library code over reimplementing logic in the script.
- If a script exercises redline behavior, inspect `../lib/redline/AGENTS.md` first.

## Files

- `benchmark-handcrafted-instruction-parser.ts`: benchmarks the handcrafted instruction parser.
- `compare-paragraph-splitters.ts`: compares paragraph splitting strategies.
- `handcrafted-instruction-parser.test.ts`: script-style parser test harness.
- `run-pdf-pipeline-failures.ts`: reruns or inspects failing PDF pipeline cases.
- `search.ts`: developer-facing search script.
