# Source Root Guide

This directory holds the web app entrypoints: app shells, route entrypoints, and Worker bindings.

- `App.tsx` is the main app entrypoint.
- `PdfApp.tsx` is the redline UI entrypoint.
- `worker.ts` owns Worker runtime routing.
- If the task is local to entrypoints, stay here.
- If the task moves into UI internals, read `../components/AGENTS.md` or `../pages/AGENTS.md`.
- If the task moves into redline logic, read `../lib/redline/AGENTS.md`.

## Files

- `App.tsx`: main application shell for the standard web app.
- `PdfApp.tsx`: main UI shell for the PDF redline experience.
- `entry-client.tsx`: browser entrypoint for the standard app.
- `entry-client-pdf.tsx`: browser entrypoint for the PDF app.
- `entry-server.tsx`: server-side render entrypoint for the standard app.
- `entry-server-pdf.tsx`: server-side render entrypoint for the PDF app.
- `worker.ts`: Cloudflare Worker entrypoint and request router.
