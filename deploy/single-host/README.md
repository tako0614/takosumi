# Takosumi Service — single-host reference distribution

Substrate-neutral service/storage counterpart to `deploy/cloudflare/`. Brings up the Takosumi service + Postgres + MinIO + Caddy on any Docker host (single VM, container host, k8s pod via kompose). OpenTofu execution is attached separately through RunnerProfile.

The service here is the same `src/service/index.ts` that ships to Cloudflare Workers. It uses the runtime-neutral `RuntimeAdapter` under `src/service/shared/runtime/` and is run through the Bun path in this distribution.

## Quick start

```bash
cd deploy/single-host
cp .env.example .env  # edit values
docker compose up -d

# wait until service reports healthy
curl -k https://localhost/healthz

# create a PlanRun through the canonical Deploy Control entry point
curl -X POST https://localhost/v1/plan-runs \
  -H "Authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "spaceId": "space:personal",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/app.git",
      "ref": "main"
    },
    "requiredProviders": ["registry.opentofu.org/cloudflare/cloudflare"]
  }'
```

## Required `.env`

Set strong, unique secrets for each of:

```
POSTGRES_PASSWORD          # Postgres superuser passphrase
MINIO_ROOT_PASSWORD        # MinIO admin passphrase
TAKOSUMI_DEPLOY_CONTROL_TOKEN   # bearer token for Deploy Control API routes
TAKOSUMI_INTERNAL_API_SECRET  # shared secret for service ↔ admin RPC
TAKOSUMI_HOSTNAME          # public hostname (Caddy issues TLS for this)
```

`MINIO_ROOT_USER` defaults to `takosumi` and is fine to leave unchanged.

## Files

- `compose.yml` — Postgres + MinIO + service + Caddy stack
- `Dockerfile.service` — service image (Bun + workspace bundle)
- `Caddyfile.example` — reverse proxy + automatic HTTPS template
- `schema.sql` — initial Postgres schema (loaded by `docker-entrypoint-initdb.d`)
- `.env.example` — template for required secrets

## Operator notes

- The service exposes `/v1/plan-runs` and `/v1/apply-runs` as the canonical mutation API. Installation routes are read/projection routes.
- OpenTofu execution is operator-owned RunnerProfile scope. Attach a Cloudflare Container runner, external runner, or private workflow engine that enforces provider allowlists, credential refs, state backend, and network policy.
- Provider credentials and state backend credentials must not be mounted into tenant workloads.

## Substrate matrix

| substrate                         | reference                        | status                         |
| --------------------------------- | -------------------------------- | ------------------------------ |
| Cloudflare Workers + D1 + R2      | `deploy/cloudflare/`             | verified                       |
| Single VM (Docker compose)        | `deploy/single-host/` (this dir) | verified                       |
| Kubernetes (Helm chart)           | n/a                              | spec-compliant, operator-owned |
| AWS (ECS / Fargate + RDS + S3)    | n/a                              | spec-compliant, operator-owned |
| GCP (Cloud Run + Cloud SQL + GCS) | n/a                              | spec-compliant, operator-owned |

Provider enablement for AWS / GCP / Kubernetes and other substrates is operator-owned. Operators bring their own OpenTofu modules and runner profile evidence, then publish well-known non-sensitive OpenTofu outputs into DeploymentOutput records and configure workload platform service resolvers when needed.

## Why two reference distributions

The architectural claim that the Takosumi service is substrate-neutral needs working deployment evidence, not only source structure. See `docs/reference/operator.md` and the ecosystem-level `ARCHITECTURE.md` for the boundary.
