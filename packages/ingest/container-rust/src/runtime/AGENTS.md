# Runtime Guide

This directory holds shared Rust runtime infrastructure such as fetching, callbacks, caching, logging, and orchestration.

- Keep runtime plumbing separate from jurisdiction parsing logic.
- Changes here can affect every source.
- Be careful with callback, caching, and orchestration changes because they alter runtime behavior globally.

## Files

- `cache.rs`: runtime caching primitives.
- `callbacks.rs`: callback transport or callback helpers.
- `fetcher.rs`: shared fetching logic.
- `logging.rs`: runtime logging helpers.
- `mod.rs`: runtime module exports.
- `orchestrator.rs`: top-level runtime orchestration logic.
- `types.rs`: shared runtime types.
