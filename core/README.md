# Takosumi Service

Reference service for the OpenTofu-native Takosumi control plane. The target
public model is Workspace, Project, Capsule, Source, ProviderConnection,
CredentialRecipe, ProviderBinding, Secret, Run, Plan, Apply, Destroy,
StateVersion, Output, Runner, AuditEvent, and Operator.

The service records source identity, provider bindings, policy decisions, logs,
state versions, outputs, run history, and audit evidence. It does not hold
provider credential values. OpenTofu execution runs through the internal
runner/profile machinery selected by the operator and resolved from
ProviderConnection + CredentialRecipe + ProviderBinding + policy.

Current implementation routes and stores still contain legacy Space,
Installation, Dependency, RunGroup, StateSnapshot, OutputSnapshot, Deployment,
OutputShare, and Activity names. Treat those as migration debt or internal
compatibility vocabulary. They should be mapped back to Workspace, Project,
Capsule, Run, StateVersion, Output, output-to-input wiring, and AuditEvent when
describing the public product.

## Run From Source

```bash
cd takosumi
bun install
PORT=8788 bun core/index.ts
```

## Internal deploy-control seam (`/internal/v1`)

This `core/api` Hono table is **not** edge-reachable. It is the in-process deploy-control seam dialed by the accounts
composition; the single edge-public surface is `/api/v1/*`, owned by the accounts router (see
[`docs/reference/deploy-control-api.md`](../docs/reference/deploy-control-api.md)). The seam uses the current
Workspace / Capsule / StateVersion route vocabulary:

- `POST /internal/v1/workspaces` / `GET /internal/v1/workspaces`
- `POST /internal/v1/sources` / `POST /internal/v1/sources/{id}/sync`
- `POST /internal/v1/connections/*` / `GET /internal/v1/connections`
- `POST /internal/v1/workspaces/{workspaceId}/capsules`
- `POST /internal/v1/capsules/{id}/plan`
- `POST /internal/v1/runs/{id}/approve`
- `POST /internal/v1/capsules/{id}/destroy-plan`
- `GET /internal/v1/capsules/{id}/state-versions`
- `GET /internal/v1/state-versions/{id}`
- `GET /internal/v1/workspaces/{workspaceId}/activity`

These route names are internal implementation details. New docs and API surfaces should describe Workspace /
Project / Capsule / Source / ProviderConnection / CredentialRecipe /
ProviderBinding / Secret / Run / Plan / Apply / Destroy / StateVersion /
Output / Runner / AuditEvent / Operator unless they are explicitly documenting
this migration seam.

The `/internal/v1/plan-runs`, `/internal/v1/apply-runs`, `/internal/v1/runner-profiles`, and
`/internal/v1/capsules/*` ledger routes are part of the same internal seam dialed by the accounts plane / CLI. They
are not surfaced through `/capabilities` or `/openapi.json`. (The account-plane product surface `/v1/capsule-projections` and
the session-authed control surface `/api/v1/connections` are a distinct edge API, owned by the accounts plane, not this
seam. Connections are served only under `/api/v1/connections`; there is no `/v1/connections` edge.)

## Operator / internal extensions

- Optional `/internal/v1/artifacts*` routes — operator-internal object extension, not part of public Deploy Control v1
- `/internal/v1/runtime/agents/*` — compatibility fleet ledger for private operator distributions
- `TakosumiDeploymentRecordStore` — internal apply evidence and status for reference implementation workflows

These extensions must not introduce full AWS/GCP/Cloudflare clone APIs,
Resource Driver systems, Compat Pack systems, managed resources, official
resource backends, or hard-coded Cloud behavior. OSS Takosumi may expose scoped
compatibility profile framework/capabilities, but official hosted profile
implementations and managed-resource behavior belong outside this repo's public
control-plane contract.

## Required env (production)

| Env var                            | Description                                 |
| ---------------------------------- | ------------------------------------------- |
| `TAKOSUMI_DATABASE_URL`            | Postgres URL for state / record store       |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | Symmetric key for at-rest secret encryption |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN`    | Bearer for Deploy Control API routes        |
| `TAKOSUMI_ENVIRONMENT=production`  | strict-runtime checks                       |

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
