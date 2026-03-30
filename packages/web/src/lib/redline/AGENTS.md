# Redline Guide

This directory is the redline orchestration boundary.

- Keep parser and PDF-processing orchestration here.
- Do not move amendment semantic infrastructure into this directory unless the abstraction is genuinely redline-specific.
- UI code should consume this layer rather than reimplement it.
- Read `../../../../../docs/agents/redline-pipeline.md` for workflow expectations.

## Files

- No direct files live here today. This directory is split into `amendment-parser/` and `pdf/`.
