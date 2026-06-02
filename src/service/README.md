# @takosjp/takosumi

Reference service for the manifestless Takosumi Installer API. It receives Source install/deploy requests over HTTP,
returns `InstallPlan` dry-runs, records Installation / Deployment state, and resolves PlatformService bindings through
operator-provided inventory.

The service does not hold cloud provider credentials and does not run Terraform/OpenTofu.

## Install

```bash
npm install @takosjp/takosumi
takosumi server
```

## Public installer endpoints

- `POST /v1/installations/dry-run` — new Installation dry-run
- `POST /v1/installations` — Installation create + first Deployment
- `POST /v1/installations/{id}/deployments/dry-run` — update dry-run
- `POST /v1/installations/{id}/deployments` — apply a new Deployment
- `POST /v1/installations/{id}/rollback` — rollback to a prior Deployment

## Operator / internal extensions

- Optional `/v1/artifacts*` routes — operator DataAsset extension
- `/api/internal/v1/runtime/agents/*` — runtime-agent fleet enrollment / lease / heartbeat
- `TakosumiDeploymentRecordStore` — internal apply evidence and status for reference implementation workflows

## Required env (production)

| Env var | Description |
| --- | --- |
| `TAKOSUMI_DATABASE_URL` | Postgres URL for state / record store |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | Symmetric key for at-rest secret encryption |
| `TAKOSUMI_INSTALLER_TOKEN` | Bearer for `/v1/installations/*` |
| `TAKOSUMI_DEPLOY_TOKEN` | Bearer for optional DataAsset write routes |
| `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN` | runtime-agent locator |
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
  platformServices: {
    async resolve(selection) {
      if (selection.name !== "identity") return [];
      return [{
        path: "identity.primary.oidc",
        kind: "identity.oidc",
        material: { issuer: "https://accounts.example.test" },
      }];
    },
  },
});

const server = Bun.serve({ port: 8788, fetch: app.fetch });
```

`createTakosumiService` builds the Hono app, wires adapter ports, mounts route modules for the configured process role, and
passes PlatformService resolver configuration to the Installer pipeline.

## See also

- `@takosjp/takosumi/runtime-agent` — lifecycle execution host
- `@takosjp/takosumi/cli` — operator CLI
- `@takosjp/takosumi/contract` — Installer API wire types
