# Takosumi Cloudflare Worker Scaffold

This directory is the Worker-first deployment scaffold for running the Takosumi
control plane on Cloudflare without a container runtime. The Worker builds the
kernel in-process with `createPaaSApp`, uses D1 for Worker-side kernel
persistence and public deploy lifecycle records, and uses R2 for artifact object
storage.

## Files

- `wrangler.toml`: Worker, D1, R2, Queue, and coordination Durable Object
  binding template. Wrangler runs a Deno bundle custom build and uploads the
  bundled Worker without a second esbuild pass.
- `src/worker.ts`: Worker entrypoint.
- `src/handler.ts`: route dispatcher that keeps edge-local health/storage probes
  local and dispatches Takosumi kernel routes to an in-process Hono app.
- `src/d1_storage.ts`: D1-backed snapshot storage driver for kernel stores.
- `src/d1_deploy_stores.ts`: D1-backed public deploy record, idempotency,
  operation journal, and revoke-debt stores.
- `src/r2_object_storage.ts`: R2-backed `ObjectStoragePort` for artifacts.

## Routing Shape

The Worker directly handles the kernel control-plane paths. Method, path, query,
body, and auth headers are preserved:

- `/v1/*` for public deploy and artifact APIs.
- `/api/internal/v1/*` for operator/internal APIs.
- `/api/internal/v1/runtime/agents/*` for runtime-agent RPC, dispatched to an
  in-process `takosumi-runtime-agent` app.
- `/health`, `/capabilities`, `/readyz`, `/livez`, `/status/summary`,
  `/openapi.json`, and `/metrics`.

The Worker-local routes remain at the edge:

- `/healthz` reports Worker health only.
- `/coordination/*` routes to `TakosCoordinationObject`.
- `/storage/healthz` checks D1/R2 bindings.
- `/queue/test` verifies Queue producer wiring.

There is no `/runtime/*` container routing in this scaffold. Workload runtimes
must be represented by provider/materializer configuration rather than by a
hard-coded container binding.

## Persistence

D1 is used in two places:

- `CloudflareD1SnapshotStorageDriver` persists the kernel storage snapshot.
- `createCloudflareD1DeployStores` persists public deploy records, idempotency
  replay responses, WAL stage journal entries, deploy locks, and revoke-debt
  records.

R2 is used by the artifact routes through `CloudflareR2ObjectStorage`. The
adapter stores Takosumi digests in R2 custom metadata and verifies digests on
read.

## Operator Steps

1. Replace placeholder D1/R2/Queue identifiers in `wrangler.toml`.
2. Configure Worker secrets/vars such as `TAKOSUMI_DEPLOY_TOKEN`,
   `TAKOSUMI_DEPLOY_SPACE_ID`, `TAKOSUMI_INTERNAL_API_SECRET`,
   `TAKOSUMI_SECRET_STORE_PASSPHRASE`, and optional
   `TAKOSUMI_METRICS_SCRAPE_TOKEN`.
3. Keep `TAKOS_RUNTIME_MODE=cloudflare-worker`.
4. Deploy with either `wrangler deploy --config deploy/cloudflare/wrangler.toml`
   from the product root or `wrangler deploy` from this directory.

Do not replace kernel `/readyz` with a Worker-local response. Kernel readiness
checks still come from the in-process kernel app.
