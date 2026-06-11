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

## Public control-plane endpoints

The public surface is the §30 `/api` model: Spaces, Sources, Connections, Installations, Dependencies, Runs, RunGroups,
Deployments, OutputShares, and Activity.

- `POST /api/spaces` / `GET /api/spaces`
- `POST /api/sources` / `POST /api/sources/{id}/sync`
- `POST /api/connections/*` / `GET /api/connections`
- `POST /api/spaces/{spaceId}/installations`
- `POST /api/installations/{id}/plan`
- `POST /api/runs/{id}/approve`
- `POST /api/installations/{id}/destroy-plan`
- `GET /api/installations/{id}/deployments`
- `GET /api/deployments/{id}`
- `GET /api/spaces/{spaceId}/activity`

The legacy `/v1/plan-runs`, `/v1/apply-runs`, `/v1/runner-profiles`, and `/v1/installations/*` ledger routes are an
internal compatibility seam for the accounts plane / CLI. They are not surfaced through `/capabilities` or
`/openapi.json`.

## Operator / internal extensions

- Optional `/v1/artifacts*` routes — operator-internal object extension, not part of public Deploy Control v1
- `/api/internal/v1/runtime/agents/*` — compatibility fleet ledger for private operator distributions
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
