# @takos/takosumi-kernel

Control plane for the Takosumi self-host PaaS toolkit. Receives manifest deploys
over HTTP, runs the apply pipeline (DAG-ordered, idempotent,
concurrency-locked), and forwards lifecycle envelopes to a runtime-agent that
does the actual cloud SDK / OS work.

The kernel never holds cloud credentials.

## Install

```bash
deno run -A jsr:@takos/takosumi-kernel
```

Most operators run the kernel via the CLI:
[`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli) (`takosumi server`).

## What it owns

- `POST /v1/deployments` — operator deploy entrypoint (apply / plan / destroy
  modes, bearer auth via `TAKOSUMI_DEPLOY_TOKEN`)
- `GET /v1/deployments[/:name]` — state query
- `POST /v1/artifacts` (multipart upload) + GET / HEAD / DELETE / list / GC /
  kinds — artifact store
- `POST /v1/runtime-agent/*` — runtime-agent fleet enrollment / lease /
  heartbeat
- `applyV2` — DAG topological apply with idempotency (spec fingerprint),
  rollback on partial failure, concurrency lock per `(tenant, deployment)`
- `destroyV2` — reverse-order teardown with persisted handle resolution
- `TakosumiDeploymentRecordStore` — persists `(manifest, applied[],
  status)`.
  SQL backend via `TAKOSUMI_DATABASE_URL` also persists the public deploy lease
  lock and public OperationPlan WAL stage records; in-memory fallback is dev /
  test only.

## Required env (production)

| Env var                                         | Description                                           |
| ----------------------------------------------- | ----------------------------------------------------- |
| `TAKOSUMI_DATABASE_URL`                         | Postgres URL for state / record store                 |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE`              | Symmetric key for at-rest secret encryption           |
| `TAKOSUMI_DEPLOY_TOKEN`                         | Bearer for `POST /v1/deployments` and artifact write  |
| `TAKOSUMI_DEPLOY_SPACE_ID`                      | Public deploy Space scope (default `takosumi-deploy`) |
| `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN`   | runtime-agent locator                                 |
| `TAKOSUMI_AUDIT_REPLICATION_KIND` + sink config | external audit replica                                |
| `TAKOSUMI_ENVIRONMENT=production`               | gates strict-runtime adapter check                    |

For dev:

```bash
export TAKOSUMI_DEV_MODE=1   # allows in-memory fallbacks for non-strict ports
```

## API

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";

const { app, context, role } = await createPaaSApp({
  runtimeEnv: Deno.env.toObject(),
  // optional: takosumiDeploymentRecordStore, sqlClient
});

Deno.serve({ port: 8788 }, app.fetch);
```

`createPaaSApp` does:

1. Loads runtime config from env
2. `registerBundledShapesAndProviders` — auto-registers 5 bundled shapes, 2
   templates, and 21 production providers (HTTP wrappers to runtime-agent)
3. Builds `AppContext` with adapter ports (auth / kms / secrets / queue /
   storage / observability / objectStorage / runtimeAgentRegistry / etc)
4. Mounts the route modules that match the configured process role:
   - `takosumi-api` → internal + public + readiness + openapi + artifact +
     deploy-public
   - `takosumi-worker` → readiness + worker daemon
   - `takosumi-runtime-agent` → runtime-agent fleet routes
5. Returns the Hono app

## Adapter ports

`AppContext.adapters` exposes 15 pluggable adapter ports (auth, kms, secrets,
queue, storage, observability, objectStorage, etc). All are optional in dev —
the kernel logs which ports fell back to in-memory at boot. In production /
staging, missing strict-runtime ports fail the boot.

See [`packages/kernel/src/app_context.ts`](./src/app_context.ts) for the full
list.

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
  — executor / data plane
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  catalog + provider plugins
- [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli) — operator CLI
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) — type
  contract

> The `@takos/` JSR scope is the reference Takosumi distribution published by
> Takos; authority lives in the contract, not in the publisher — alternative
> publishers (e.g., `@example/takosumi-kernel`) are spec-permitted, currently
> untested, and hold no architectural privilege.
