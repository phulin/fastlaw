# Web Runtime Boundaries Guide

## When To Read

- worker endpoint changes
- browser/server boundary changes
- PDF processing worker changes
- code movement across UI, web worker, and server runtimes

## Runtime Map

- Browser app and route UI
- PDF processing worker
- server and Worker runtime endpoints

## Invariants

- Keep browser-only code out of Worker/server paths.
- Keep heavy PDF processing off the main UI thread where possible.
- Do not move logic across runtime boundaries without checking imports, bundling, and execution constraints.

## Verification

- Run the web test suite for behavioral changes.
- Manually check the affected runtime boundary when the change is not well-covered by tests.
- Always finish with `yarn check:fix && yarn typecheck`.
