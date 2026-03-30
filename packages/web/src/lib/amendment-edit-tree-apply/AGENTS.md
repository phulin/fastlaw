# Apply Engine Guide

This directory holds scope resolution, execution, summaries, and apply-layer types.

- Keep apply semantics and resolution logic here, not in the pipeline UI.
- Unsupported or partial cases should stay explicit.
- Be careful with sequencing and scope resolution changes.
- Read `../../../../../docs/agents/redline-application.md` before editing behavior.

## Files

- `execute.ts`: executes resolved amendment operations against the canonical document.
- `resolve.ts`: resolves scopes and targets before execution.
- `summary.ts`: builds summaries of apply results.
- `types.ts`: apply-layer result and helper types.
