# Takosumi Service

Reference service for the OpenTofu-native Takosumi control plane. It records Space, Source, Connection, Installation,
Dependency, Run, RunGroup, StateSnapshot, OutputSnapshot, Deployment, policy decisions, logs, and audit events.

The service does not hold provider credential values. OpenTofu execution runs through the internal runner/profile
machinery selected by the operator and resolved from Connection + ProviderBinding + policy.

## Run From Source

```bash
cd takosumi
bun install
bun src/cli/main.ts server --port 8788
```

## Internal deploy-control seam (`/internal/v1`)

This `core/api` Hono table is **not** edge-reachable. It is the in-process deploy-control seam dialed by the accounts
composition; the single edge-public surface is `/api/v1/*`, owned by the accounts router (see
[`docs/reference/deploy-control-api.md`](../docs/reference/deploy-control-api.md)). The seam models the §30 vocabulary —
Spaces, Sources, Connections, Installations, Dependencies, Runs, RunGroups, Deployments, OutputShares, and Activity:

- `POST /internal/v1/spaces` / `GET /internal/v1/spaces`
- `POST /internal/v1/sources` / `POST /internal/v1/sources/{id}/sync`
- `POST /internal/v1/connections/*` / `GET /internal/v1/connections`
- `POST /internal/v1/spaces/{spaceId}/installations`
- `POST /internal/v1/installations/{id}/plan`
- `POST /internal/v1/runs/{id}/approve`
- `POST /internal/v1/installations/{id}/destroy-plan`
- `GET /internal/v1/installations/{id}/deployments`
- `GET /internal/v1/deployments/{id}`
- `GET /internal/v1/spaces/{spaceId}/activity`

The `/internal/v1/plan-runs`, `/internal/v1/apply-runs`, `/internal/v1/runner-profiles`, and
`/internal/v1/installations/*` ledger routes are part of the same internal seam dialed by the accounts plane / CLI. They
are not surfaced through `/capabilities` or `/openapi.json`. (The account-plane product surface `/v1/installations` and
the session-authed control surface `/api/v1/connections` are a distinct edge API, owned by the accounts plane, not this
seam. Connections are served only under `/api/v1/connections`; there is no `/v1/connections` edge.)

## Operator / internal extensions

- Optional `/internal/v1/artifacts*` routes — operator-internal object extension, not part of public Deploy Control v1
- `/internal/v1/runtime/agents/*` — compatibility fleet ledger for private operator distributions
- `TakosumiDeploymentRecordStore` — internal apply evidence and status for reference implementation workflows

## Required env (production)

| Env var | Description |
| --- | --- |
| `TAKOSUMI_DATABASE_URL` | Postgres URL for state / record store |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | Symmetric key for at-rest secret encryption |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | Bearer for Deploy Control API routes |
| `TAKOSUMI_ENVIRONMENT=production` | strict-runtime checks |

For dev:

```bash
export TAKOSUMI_DEV_MODE=1
```

## API

```typescript
import { createTakosumiService } from "./bootstrap.ts";

const { app } = await createTakosumiService({
  runtimeEnv: process.env,
});

const server = Bun.serve({ port: 8788, fetch: app.fetch });
```

`createTakosumiService` builds the Hono app, wires adapter ports, mounts route modules for the configured process role,
and passes internal runner/profile and store configuration to the deploy control pipeline.

## Storage implementation note

Drizzle schema scaffolding now exists for the deploy-control D1 and Postgres tables, but the active stores and migration
runner are still the existing raw SQL implementations. Generated Drizzle SQL is not an operator migration source yet.
Before any store is switched to Drizzle, the Drizzle schemas must be kept as exact physical mappings of the live D1 and
Postgres tables and any generated SQL must be folded into the checksumed `StorageMigrationRunner` catalog.

## See also

- `docs/reference/cli.md` — operator CLI
- `docs/reference/deploy-control-api.md` — public `/api` surface
