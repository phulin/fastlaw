# Redline Application Guide

## When To Read

- amendment planner changes
- edit-tree changes
- apply engine changes
- canonical document model changes

## Ownership Boundaries

- The planner computes concrete operations from semantic edit structures.
- The apply engine resolves scope and executes those operations against canonical structure.
- The redline pipeline consumes these modules. It should not redefine their semantics locally.

## Invariants

- Root targeting metadata must be explicit.
- Avoid legacy fallback behavior unless the task explicitly concerns migration or shadow-mode comparison.
- Unsupported states should stay explicit instead of being silently coerced into partial success.

## Risk Areas

- scope resolution
- multi-operation sequencing
- redesignation and move behavior
- preserving debuggability for unsupported or partial cases

## Test Expectations

- Add focused unit tests around semantic changes.
- Keep or extend integration coverage for representative bill text and amendment instructions.
- Favor targeted tests over broad refactors without coverage.

## Deep Reference

- Use `../design/parser-ast-edit-tree-transition.md` when the change affects parser-native targeting, translation, or apply-path semantics.
