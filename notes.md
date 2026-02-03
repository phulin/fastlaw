# Notes: Ingest Containers (Cloudflare)

## Sources

### Cloudflare Containers overview/config
- URLs:
  - https://developers.cloudflare.com/containers/
  - https://developers.cloudflare.com/containers/get-started/
- Key points:
  - Containers are configured via Wrangler with `[[containers]]` and Durable Object bindings and migrations.
  - Worker uses `getContainer()` or DO binding to route requests to container instances.

### Container package
- URL: https://developers.cloudflare.com/containers/container-package/
- Key points:
  - `Container` class extends Durable Object.
  - Supports `sleepAfter`, `defaultPort`, env var injection.

### Env vars and secrets for containers
- URL: https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
- Key points:
  - Pass Worker Secrets and Secret Store values into containers via env vars.
  - Per-instance env vars can be passed when starting a container.

### Container runtime env vars
- URL: https://developers.cloudflare.com/containers/platform-details/environment-variables/
- Key points:
  - Container runtime sets standard CF env vars; user-defined env vars supported.

### Durable Object container API
- URL: https://developers.cloudflare.com/durable-objects/api/container/
- Key points:
  - `ctx.container.start()` and related methods for starting containers.

## Repo context
- `packages/ingest/src/worker.ts` currently calls `ingestUSC` and `ingestCGA` directly.
- Ingest functions rely on `Env` bindings for D1 and R2.
- `packages/ingest/wrangler.toml` currently has D1/R2 bindings and env vars.

## Open items
- Confirm D1 HTTP API credentials and endpoint format.
- Confirm R2 S3 credentials and endpoint format.
- Confirm Worker wait strategy (polling vs callbacks vs status store).
