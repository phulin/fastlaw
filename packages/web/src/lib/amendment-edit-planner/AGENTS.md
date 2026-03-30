# Amendment Planner Guide

This directory holds handler-based planning logic that turns semantic edits into concrete operations.

- Keep planning concerns here; do not mix in PDF or UI orchestration.
- Handlers should stay explicit and operation-specific.
- Changes here usually need focused unit coverage.
- Read `../../../../../docs/agents/redline-application.md` before changing semantics.

## Files

- No direct files live here today. This directory exists to group operation-specific handlers.
