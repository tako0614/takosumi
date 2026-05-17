# Takosumi Kernel — selfhost reference distribution

Substrate-neutral counterpart to `deploy/cloudflare/`. Brings up the
full Takosumi PaaS kernel + runtime-agent + Postgres + MinIO + Caddy
on any Docker host (single VM, container host, k8s pod via kompose).

The kernel here is the same `packages/kernel/src/index.ts` that ships
to Cloudflare Workers. It uses the runtime-neutral `RuntimeAdapter`
under `packages/kernel/src/shared/runtime/` and so runs identically
on Deno (this distribution), Node 22+ (via Deno's Node compat), and
Cloudflare Workers (via `deploy/cloudflare/`).

## Quick start

```bash
cd deploy/selfhosted
cp .env.example .env  # edit values
docker compose up -d

# wait until kernel reports healthy
curl -k https://localhost/healthz

# deploy a manifest through the canonical entry point
curl -X POST https://localhost/v1/deployments \
  -H "Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  --data @../../fixtures/manifest.example.json
```

## Required `.env`

Set strong, unique secrets for each of:

```
POSTGRES_PASSWORD          # Postgres superuser passphrase
MINIO_ROOT_PASSWORD        # MinIO admin passphrase
TAKOSUMI_DEPLOY_TOKEN      # bearer token for POST /v1/deployments
TAKOSUMI_INTERNAL_API_SECRET  # shared secret for kernel ↔ admin RPC
TAKOSUMI_AGENT_TOKEN       # bearer token between kernel and runtime-agent
TAKOSUMI_HOSTNAME          # public hostname (Caddy issues TLS for this)
```

`MINIO_ROOT_USER` defaults to `takosumi` and is fine to leave unchanged.

## Files

- `compose.yml` — Postgres + MinIO + kernel + runtime-agent + Caddy stack
- `Dockerfile.kernel` — kernel image (Deno + workspace bundle)
- `Dockerfile.runtime-agent` — runtime-agent image (Deno + connector tree)
- `Caddyfile.example` — reverse proxy + automatic HTTPS template
- `schema.sql` — initial Postgres schema (loaded by `docker-entrypoint-initdb.d`)
- `.env.example` — template for required secrets

## Operator notes

- The kernel exposes `POST /v1/deployments` as the canonical deploy
  entry point. CLI / GitHub Actions / custom CI all hit this URL with a
  bearer token; `takosumi-git` is one optional client among many.
- `runtime-agent` receives provider apply / destroy calls from the
  kernel and dispatches them to the bundled connector tree under
  `packages/runtime-agent/src/connectors/`. The selfhost connectors
  (`docker_compose`, `local_docker_postgres`, `filesystem`, `minio`,
  `coredns_local`, `systemd_unit`) are wired by default; AWS / GCP /
  Azure / k8s connectors are also bundled and activate when the
  matching provider plugin is selected by a manifest.
- The runtime-agent needs `/var/run/docker.sock` mounted to drive
  user-deployed containers via the `selfhost-docker-compose` provider.
  Lock this down with rootless Docker or Podman in production.
- For multi-host deployments, replace the `runtime-agent` service with
  one runtime-agent process per host and configure the kernel with
  `TAKOSUMI_AGENT_REGISTRY` to fan out apply calls. See
  `docs/operator/self-host.md` for the multi-agent topology.

## Substrate matrix

| substrate                         | reference                       | status                              |
| --------------------------------- | ------------------------------- | ----------------------------------- |
| Cloudflare Workers + D1 + R2      | `deploy/cloudflare/`            | verified                            |
| Single VM (Docker compose)        | `deploy/selfhosted/` (this dir) | verified                            |
| Kubernetes (Helm chart)           | n/a                             | spec-compliant, operator-owned      |
| AWS (ECS / Fargate + RDS + S3)    | n/a                             | spec-compliant, operator-owned      |
| GCP (Cloud Run + Cloud SQL + GCS) | n/a                             | spec-compliant, operator-owned      |

The provider plugins and runtime-agent connectors for AWS / GCP /
Azure / Kubernetes are production-grade (see
`packages/runtime-agent/src/connectors/{aws,gcp,azure,kubernetes}/`)
but no reference deploy artifact for the kernel itself ships there.
Operators bring their own Terraform / Helm / Pulumi to land the
kernel image and runtime-agent image on those substrates.

## Why two reference distributions

The architectural claim that the Takosumi kernel is substrate-neutral
needs a second working deployment to be more than a spec promise.
This distribution is that second working deployment. See
`docs/reference/architecture/paas-provider-architecture.md` and the
ecosystem-level `ARCHITECTURE.md` for the substitutability table.
