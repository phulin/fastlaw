# Components Guide

This directory holds reusable UI components for both the general app and the PDF redline experience.

- Keep components presentational unless they clearly own a local interaction.
- Do not move parsing or amendment logic into components.
- `PdfWorkspace`, `AnnotationLayer`, and `AmendedSnippet` are redline-facing consumers of deeper logic.
- If a change affects redline semantics, also read `../../../../docs/agents/redline-pipeline.md` or `../../../../docs/agents/redline-application.md`.

## Files

- `AmendedSnippet.tsx`: renders amendment outcomes and replacement snippets.
- `AnnotationLayer.tsx`: renders PDF-side annotations over extracted content.
- `Breadcrumbs.tsx`: displays breadcrumb navigation for standard app pages.
- `Footer.tsx`: shared application footer.
- `Header.tsx`: shared application header.
- `InstructionDebugModal.tsx`: shows debug details for parsed instructions.
- `PageRow.tsx`: renders a page row in the PDF workspace.
- `PdfUploadDropzone.tsx`: handles PDF upload entry UX.
- `PdfWorkspace.tsx`: coordinates the PDF viewing and annotation workspace.
