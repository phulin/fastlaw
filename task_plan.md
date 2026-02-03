# Task Plan: Ingest Containers Design Doc

## Goal
Produce a detailed design doc for moving USC/CGA ingestion into a Cloudflare Container (one image, one container per request) with Worker-triggered runs, HTTP API access to D1/R2, and a progress mechanism.

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: Research/gather information
- [x] Phase 3: Draft design doc
- [x] Phase 4: Review and deliver

## Key Questions
1. What credentials and endpoints are required to access D1 and R2 via HTTP APIs from a container?
2. What progress mechanism should the Worker use to wait on container work without timeouts?
3. What code and configuration changes are required in this repo?

## Decisions Made
- Use one container image for both USC and CGA ingestion, one container instance per request.
- Container accesses D1 and R2 via HTTP APIs using env vars sourced from Wrangler secrets.

## Errors Encountered
- None

## Status
**Completed** - Design doc delivered.
