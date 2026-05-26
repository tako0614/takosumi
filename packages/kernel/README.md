# @takos/takosumi-kernel

Control plane for the Takosumi reference runtime. Receives AppSpec install and deployment requests over HTTP and runs the apply pipeline (DAG-ordered, idempotent, concurrency-locked). The takosumi.com reference adapters forward lifecycle envelopes to runtime-agent; other operator bindings can use native controllers or operator-owned execution hosts.

The kernel never holds cloud credentials.

## Install

```bash
deno run -A jsr:@takos/takosumi-kernel
```

Most operators run the kernel via the CLI: [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli) (`takosumi server`).

## Public installer endpoints

- `POST /v1/installations/dry-run` — new Installation dry-run
- `POST /v1/installations` — Installation create + first Deployment
- `POST /v1/installations/{id}/deployments/dry-run` — update dry-run
- `POST /v1/installations/{id}/deployments` — apply a new Deployment
- `POST /v1/installations/{id}/rollback` — rollback to a prior Deployment

## Operator / internal extensions

- Optional `/v1/artifacts*` routes — operator DataAsset extension
- `/api/internal/v1/runtime/agents/*` — runtime-agent fleet enrollment / lease / heartbeat
- `applyV2` — DAG topological apply with idempotency (spec fingerprint), rollback on partial failure, concurrency lock per `(tenant, deployment)`
- `destroyV2` — reverse-order teardown with persisted handle resolution
- `TakosumiDeploymentRecordStore` — persists internal apply evidence: AppSpec digest / source summary, component JSON outputs, internal operation/resource evidence, and status. SQL backend via `TAKOSUMI_DATABASE_URL` also persists installer lifecycle state and OperationPlan WAL stage records; in-memory fallback is dev / test only.

## Required env (production)

| Env var                                         | Description                                 |
| ----------------------------------------------- | ------------------------------------------- |
| `TAKOSUMI_DATABASE_URL`                         | Postgres URL for state / record store       |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE`              | Symmetric key for at-rest secret encryption |
| `TAKOSUMI_INSTALLER_TOKEN`                      | Bearer for `/v1/installations/*`            |
| `TAKOSUMI_DEPLOY_TOKEN`                         | Bearer for optional DataAsset write routes  |
| `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN`   | runtime-agent locator                       |
| `TAKOSUMI_AUDIT_REPLICATION_KIND` + sink config | external audit replica                      |
| `TAKOSUMI_ENVIRONMENT=production`               | gates strict-runtime adapter check          |

For dev:

```bash
export TAKOSUMI_DEV_MODE=1   # allows in-memory fallbacks for non-strict ports
```

## API

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";

const { app, context, role } = await createPaaSApp({
  runtimeEnv: Deno.env.toObject(),
  // optional: takosumiDeploymentRecordStore, sqlClient, plugins, kindAliases
  externalPublications: {
    resolve(ctx) {
      if (ctx.sourceRef !== "operator.identity.oidc") return undefined;
      return {
        issuerUrl: "https://accounts.example.test",
        clientId: "client_123",
        clientSecretRef: { secretRef: "secret://oidc/client-secret" },
      };
    },
  },
});

Deno.serve({ port: 8788 }, app.fetch);
```

`createPaaSApp` does:

1. Loads runtime config from env
2. Registers optional DataAsset metadata used by DataAsset extension routes. Component kind descriptors and implementation bindings are operator-supplied. Backend-specific reference `KernelPlugin` factories are imported from `takosumi-plugins` native kind packages such as `@takos/takosumi-kind-cloudflare-worker` or `@takos/takosumi-kind-aws-rds-postgres`, then attached via `plugins: [...]` plus an operator `kindAliases` map when short aliases are desired.
3. Builds `AppContext` with adapter ports (auth / kms / secrets / queue / storage / observability / objectStorage / runtimeAgentRegistry / etc)
4. Passes `externalPublications` to the Installer pipeline so ordinary external `listen.from` paths such as `operator.identity.oidc` resolve to operator-owned material.
5. Mounts the route modules that match the configured process role:
   - `takosumi-api` → internal + installer + readiness + openapi; DataAsset routes are mounted only when the operator enables that extension
   - `takosumi-worker` → readiness + worker daemon
   - `takosumi-runtime-agent` → runtime-agent fleet routes
6. Returns the Hono app

## Adapter ports

`AppContext.adapters` exposes 15 pluggable adapter ports (auth, kms, secrets, queue, storage, observability, objectStorage, etc). All are optional in dev — the kernel logs which ports fell back to in-memory at boot. In production / staging, missing strict-runtime ports fail the boot.

See [`packages/kernel/src/app_context.ts`](./src/app_context.ts) for the full list.

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) — lifecycle execution host
- [`@takos/takosumi-kind-*`](https://jsr.io/@takos/takosumi-kind-worker) — package-owned kind descriptors; native packages in `takosumi-plugins` also export reference adapter factories
- [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli) — operator CLI
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) — AppSpec / Installer API wire types

> The `@takos/` JSR scope is the reference Takosumi distribution published by Takos. Authority lives in the contract. Alternative publishers such as `@example/takosumi-kernel` can ship compatible kernel implementations; current verification covers the reference distribution.
