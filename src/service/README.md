# @takosjp/takosumi

Reference service for the OpenTofu-native Takosumi Deploy Control API. It records Installation, PlanRun, ApplyRun,
Deployment, DeploymentOutput, RunnerProfile policy, logs, and audit events.

The service does not hold provider credential values. OpenTofu execution runs through operator-selected runner profiles.

## Install

```bash
npm install @takosjp/takosumi
takosumi server
```

## Public deploy control endpoints

- `GET /v1/runner-profiles` — list operator-adopted RunnerProfiles
- `POST /v1/plan-runs` — create an OpenTofu plan run
- `GET /v1/plan-runs/{id}` — read a PlanRun
- `POST /v1/apply-runs` — apply a reviewed PlanRun
- `GET /v1/apply-runs/{id}` — read an ApplyRun
- `GET /v1/installations/{id}` — read Installation state
- `GET /v1/installations/{id}/deployments` — read Deployment and DeploymentOutput history
- `GET /v1/installations/{id}/deployment-outputs` — read current non-sensitive DeploymentOutput records

Destroy is planned with `POST /v1/plan-runs` using `operation: "destroy"` and executed through `POST /v1/apply-runs`.

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
import { createTakosumiService } from "@takosjp/takosumi";

const { app } = await createTakosumiService({
  runtimeEnv: process.env,
});

const server = Bun.serve({ port: 8788, fetch: app.fetch });
```

`createTakosumiService` builds the Hono app, wires adapter ports, mounts route modules for the configured process role, and
passes RunnerProfile and store configuration to the deploy control pipeline.

## See also

- `@takosjp/takosumi/cli` — operator CLI
- `@takosjp/takosumi/contract` — Deploy Control API wire types
