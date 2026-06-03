# takosumi/deploy — operator deployment profiles

Takosumi ships the OpenTofu-native Deploy Control contract, service entry, CLI,
and reference operator deployment profiles. The public service surface is
centered on RunnerProfile, PlanRun, ApplyRun, Installation, Deployment, and
DeploymentOutput.

The directories under `deploy/` are therefore **reference examples and provider
runbooks**, not part of the published framework surface and not the canonical operator
distribution. The canonical reference **composer** that embeds the service app, extends it
(dashboard / billing / install UI), and serves the one composed app from a single cloud
URL is `takosumi/deploy/` (`cloudflare/`, `node-postgres/`). New operators should
clone and adapt `takosumi/deploy/` rather than these examples.

## What lives here

| Directory          | Role                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare/`      | Worker-first service scaffold example: builds the service in-process with `createTakosumiService`, D1 persistence, optional R2 object store. Referenced by the Takos distribution profile and the local-substrate worker runner. |
| `single-host/`     | Substrate-neutral Docker compose example: service + Postgres + MinIO + Caddy on one host; OpenTofu execution is attached through RunnerProfile.                                                                          |
| `aws/`             | Operator-owned AWS OpenTofu provider profile runbook (README only).                                                                                                              |
| `gcp/`             | Operator-owned GCP OpenTofu provider profile runbook (README only).                                                                                                                                                                     |
| `azure/`           | Operator-owned Azure OpenTofu provider profile runbook (README only).                                                                                                                                                                  |
| `kubernetes/`      | Operator-owned Kubernetes / Helm OpenTofu provider profile runbook (README only).                                                                                                                                                              |
| `github/`          | Operator-owned GitHub OpenTofu provider profile runbook (README only).                                                                                                                                                              |
| `digitalocean/`    | Operator-owned DigitalOcean OpenTofu provider profile runbook (README only).                                                                                                                                                              |
| `local-substrate/` | Local Pebble + CoreDNS + Caddy dev substrate for production-equivalent hostname access.                                                                                                                                |
| `observability/`   | Reference observability wiring.                                                                                                                                                                                        |

## Why these stay here

These examples are intentionally **not relocated** into `takosumi/deploy/`:

- The Takos product distribution profile (`takos/deploy/distributions/cloudflare.json`)
  pins the exact artifact refs `../takosumi/deploy/cloudflare` and
  `../takosumi/deploy/cloudflare/wrangler.toml`, and `takos`'s
  `validate-distribution-profiles.ts` stat-checks those paths on disk.
- `deploy/local-substrate/` boots `deploy/cloudflare`'s Worker scaffold through its
  worker runner and compose wiring.

Moving them would break those cross-submodule references. They remain reference examples;
production composition and serving belong to `takosumi/deploy/`.
