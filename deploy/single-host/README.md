# Takosumi Kernel — single-host reference distribution

Substrate-neutral counterpart to `deploy/cloudflare/`. Brings up the Takosumi kernel + runtime-agent + Postgres + MinIO + Caddy on any Docker host (single VM, container host, k8s pod via kompose).

The kernel here is the same `src/kernel/index.ts` that ships to Cloudflare Workers. It uses the runtime-neutral `RuntimeAdapter` under `src/kernel/shared/runtime/` and is run through the Node/Bun path in this distribution.

## Quick start

```bash
cd deploy/single-host
cp .env.example .env  # edit values
docker compose up -d

# wait until kernel reports healthy
curl -k https://localhost/healthz

# install a Source through the canonical installer entry point
curl -X POST https://localhost/v1/installations \
  -H "Authorization: Bearer $TAKOSUMI_INSTALLER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "spaceId": "space:personal",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/app.git",
      "ref": "main"
    }
  }'
```

## Required `.env`

Set strong, unique secrets for each of:

```
POSTGRES_PASSWORD          # Postgres superuser passphrase
MINIO_ROOT_PASSWORD        # MinIO admin passphrase
TAKOSUMI_INSTALLER_TOKEN   # bearer token for /v1/installations/*
TAKOSUMI_DEPLOY_TOKEN      # optional bearer token for DataAsset write routes
TAKOSUMI_INTERNAL_API_SECRET  # shared secret for kernel ↔ admin RPC
TAKOSUMI_AGENT_TOKEN       # bearer token between kernel and runtime-agent
TAKOSUMI_HOSTNAME          # public hostname (Caddy issues TLS for this)
```

`MINIO_ROOT_USER` defaults to `takosumi` and is fine to leave unchanged.

## Files

- `compose.yml` — Postgres + MinIO + kernel + runtime-agent + Caddy stack
- `Dockerfile.kernel` — kernel image (Bun + workspace bundle)
- `Dockerfile.runtime-agent` — generic runtime-agent image (Bun + lifecycle host)
- `Caddyfile.example` — reverse proxy + automatic HTTPS template
- `schema.sql` — initial Postgres schema (loaded by `docker-entrypoint-initdb.d`)
- `.env.example` — template for required secrets

## Operator notes

- The kernel exposes `/v1/installations*` as the canonical installer API. CLI / GitHub Actions / custom CI all use that 5 endpoint surface with an installer bearer token.
- `runtime-agent` receives apply / destroy calls from the kernel and dispatches them through a connector registry. The generic runtime-agent host lives in `takosumi/src/runtime-agent/`; concrete local and cloud connectors live in `takosumi-plugins/packages/runtime-agent-connectors/` and must be wired by the operator distribution.
- The runtime-agent needs `/var/run/docker.sock` mounted to drive user-deployed containers via the Docker Compose web-service adapter. Lock this down with rootless Docker or Podman in production.
- For multi-host deployments, replace the `runtime-agent` service with one runtime-agent process per host and configure the kernel with `TAKOSUMI_AGENT_REGISTRY` to fan out apply calls. See `docs/operator/operator-managed.md` for the multi-agent topology.

## Substrate matrix

| substrate                         | reference                        | status                         |
| --------------------------------- | -------------------------------- | ------------------------------ |
| Cloudflare Workers + D1 + R2      | `deploy/cloudflare/`             | verified                       |
| Single VM (Docker compose)        | `deploy/single-host/` (this dir) | verified                       |
| Kubernetes (Helm chart)           | n/a                              | spec-compliant, operator-owned |
| AWS (ECS / Fargate + RDS + S3)    | n/a                              | spec-compliant, operator-owned |
| GCP (Cloud Run + Cloud SQL + GCS) | n/a                              | spec-compliant, operator-owned |

Native kind implementations for AWS / GCP / Kubernetes and runtime-agent connectors for AWS / GCP / Azure / Kubernetes are available for operator-attached distributions (see `takosumi-plugins/packages/kind-aws-*`, `takosumi-plugins/packages/kind-gcp-*`, `takosumi-plugins/packages/kind-kubernetes-web-service/`, and `takosumi-plugins/packages/runtime-agent-connectors/src/connectors/{aws,gcp,azure,kubernetes}/`), but no production-grade default reference deploy package for the kernel itself ships there. Operators bring their own Terraform / Helm / Pulumi to land the kernel image and runtime-agent image on those substrates.

## Why two reference distributions

The architectural claim that the Takosumi kernel is substrate-neutral needs a second working deployment to be more than a spec promise. This distribution is that second working deployment. See `docs/reference/architecture/operator-boundaries.md` and the ecosystem-level `ARCHITECTURE.md` for the substitutability table.
