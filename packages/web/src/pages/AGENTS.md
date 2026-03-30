# Pages Guide

This directory holds route-level UI.

- Keep route composition here.
- Push reusable UI into `../components` and logic into `../lib` or `../server`.
- Do not embed redline pipeline logic directly in pages.
- If a page change affects PDF/redline behavior, also inspect `../PdfApp.tsx` and `../lib/redline/AGENTS.md`.

## Files

- `DeepSearch.tsx`: route for deep or advanced search UI.
- `IngestJob.tsx`: route for a single ingest job view.
- `IngestJobs.tsx`: route for ingest job listings.
- `Node.tsx`: route for rendering an individual node view.
- `NotFound.tsx`: not-found route.
- `Search.tsx`: main search route.
