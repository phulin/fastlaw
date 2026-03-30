# Planner Handlers Guide

This directory holds per-operation planner handlers such as insert, move, redesignate, and strike variants.

- Keep each handler narrow and operation-specific.
- Share code only when duplication is real and semantic behavior stays obvious.
- Handler changes are semantic changes; add focused tests.
- Read `../../../../../../docs/agents/redline-application.md` before editing behavior.

## Files

- `insert.ts`: planner handler for insert operations.
- `move.ts`: planner handler for move operations.
- `redesignate.ts`: planner handler for redesignation operations.
- `rewrite.ts`: planner handler for rewrite operations.
- `strike-insert.ts`: planner handler for strike-and-insert combined operations.
- `strike.ts`: planner handler for strike operations.
