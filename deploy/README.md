# takosumi/deploy — reference deploy examples (not the framework surface)

Takosumi is a **framework library** you import (`@takosjp/takosumi`): it exposes a
programmatic operate-the-kernel API plus an **embeddable Hono `app`** (the 5 installer
endpoints + kernel API), and it **never self-serves**. Serving, route extension, and
production composition are the implementation's job. See
[`../AGENTS.md`](../AGENTS.md) and the ecosystem
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the framework / composer boundary.

The directories under `deploy/` are therefore **reference examples and provider
runbooks**, not part of the published framework surface and not the canonical operator
distribution. The canonical reference **composer** that embeds the kernel app, extends it
(dashboard / billing / install UI), and serves the one composed app from a single cloud
URL is `takosumi/deploy/` (`cloudflare/`, `node-postgres/`). New operators should
clone and adapt `takosumi/deploy/` rather than these examples.

## What lives here

| Directory          | Role                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare/`      | Worker-first kernel scaffold example: builds the kernel in-process with `createPaaSApp`, D1 persistence, optional R2 object store. Referenced by the Takos distribution profile and the local-substrate worker runner. |
| `single-host/`     | Substrate-neutral Docker compose example: kernel + runtime-agent + Postgres + MinIO + Caddy on one host.                                                                                                               |
| `aws/`             | Operator-owned AWS provider runbook (README only; native kinds + connectors live in `takosumi-plugins/`).                                                                                                              |
| `gcp/`             | Operator-owned GCP provider runbook (README only).                                                                                                                                                                     |
| `kubernetes/`      | Operator-owned Kubernetes provider runbook (README only).                                                                                                                                                              |
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
