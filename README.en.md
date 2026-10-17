# Takosumi

日本語: [README.md](README.md)

Takosumi is an open-source server that adds Git-hosted OpenTofu and Terraform
software to the clouds you connect, much like installing an app. Before anything
is added or updated, you can see what will be created and what will change.

Your modules and providers stay unchanged. There is no Takosumi-specific
configuration language or first-party provider; Cloudflare, AWS, Kubernetes,
and other systems are still managed by their existing providers.

[Software documentation](https://takosumi.com/docs/) ·
[Takosumi hosted service documentation](https://app.takosumi.com/docs/en/)

## What you can do

- **Pick and add** — choose a service from the Store or a Git URL, then fill in
  the connections and settings it needs.
- **Check before deploying** — see how many resources will be created, changed,
  and deleted before anything is deployed. Changes that delete, replace, or
  import something wait until you approve them.
- **Keep keys out of modules** — cloud API keys and tokens are stored in
  Takosumi. Their values cannot be read back and reach the runner only while a
  review or deploy is running.
- **Keep a record you can go back to** — Takosumi records which Git commit was
  deployed, by whom, and what changed. Each deploy keeps the state as a version,
  with its outputs, and going back to an earlier version's source is a change
  you review before it is deployed.

## Getting started

- **Use the hosted service** — sign in at [app.takosumi.com](https://app.takosumi.com/).
  The Takosumi hosted service is Pre-GA. Steps, pricing, availability, and
  support are in the
  [hosted service documentation](https://app.takosumi.com/docs/en/).
- **Try adding and deploying locally** — follow the
  [Quickstart](docs/en/getting-started/quickstart.md) to start the dashboard,
  sign-in, database, and runner on Linux with Docker. It uses `sudo` to set up a
  local certificate authority and DNS. The sample creates no external resources,
  so you need no cloud credentials.
- **Run it in your own environment** — choose a shape in
  [Running it yourself](docs/en/concepts/self-host.md). The Cloudflare template
  includes a runner; the Bun + PostgreSQL template needs a separately composed
  runner for plan and apply.
- **Run only the API** — for checking the API during development, start an
  in-memory API server with only Bun and Git by following
  [Run only the API](docs/en/getting-started/api-only.md).

## How it works

In the dashboard, what you pick in the Store and add is a **service**, and the
services you add are listed under **Workloads**. A service's own screen, opened
from Home, is an **app**. The docs and the API call an added service a
**Capsule**: one unit of deployment that bundles a Git URL, ref, and module path
with its variables and connections. Takosumi pins the ref to one commit and
records each change to a Capsule as two Runs: a plan (shown as Review) and an
apply (shown as Deploy). The apply Run is pinned to the reviewed plan Run, so
the changes you read are the changes that are deployed.

A repository may optionally publish `.well-known/takosumi.json` to add Takosumi
metadata to modules that the scan of the same commit finds. The manifest cannot
create or select a module; execution authority stays with the DB-owned
`InstallConfig`, Plan, and Run (see the
[Repository manifest reference](docs/en/reference/repository-manifest.md)).

Takoform is an ordinary provider installed from
`registry.terraform.io/tako0614/takoform`, just like any other provider. The
Takoform definitions and any service that hosts and realizes Forms are not owned
by this repository. Earlier experiments exposed `/v1/resources`, Resource
Shape, a Form Host, TargetPool, and SpacePolicy APIs and dashboard screens.
They are not part of the current software. Retained compatibility APIs,
schemas, and persistence are migration internals, not user setup instructions
or dashboard navigation.

## Takosumi and the hosted service

- **Takosumi** is the software in this repository. You can operate it in your
  own environment.
- **Takosumi hosted service** is the official service at `app.takosumi.com`.
  Hosted Forms/services, prices, capacity, and support are decisions made by
  the hosted service.

The OSS software runs without the hosted service. Hosted-service pricing, Stripe, and
private deployment targets are not public contracts of this repository. See
[Product boundaries](docs/en/concepts/boundaries.md).

Takos is a separate product.
It does not embed Accounts, deploy-control, the Dashboard, or the runner.
Its worker connects to a Takosumi endpoint as an external client.

## Documentation

- [Quickstart](docs/en/getting-started/quickstart.md) — complete local stack with dashboard and runner
- [Concepts](docs/en/concepts/index.md) — how Git modules, Runs, state, and Interfaces fit together
- [Credentials](docs/en/concepts/credentials.md) — safely passing provider credentials
- [Self-hosting](docs/en/concepts/self-host.md) — topology and operator decisions
- [Repository manifest](docs/en/reference/repository-manifest.md) — repository-owned metadata and the `InstallConfig` boundary
- [API reference](docs/en/reference/api.md)
- [CLI reference](docs/en/reference/cli.md)
- [Configuration reference](docs/en/reference/configuration.md)
- [Operator runbooks](docs/operations/README.md)
- [Hosted-properties deploy runbook](DEPLOY.md) — procedures for the hosted surfaces this repo's operator owns

## Development

```bash
bun run check
bun test
bun run docs:build
```

The main directories are `contract/` for public contracts, `core/` for the
control plane, `dashboard/` for the UI, `runner/` for execution, `deploy/` for
deployment compositions, and `docs/` for documentation.

This standalone OSS clone does not proxy Takosumi hosted-service GA or production billing
operations.

Takosumi is licensed under [AGPL-3.0-only](LICENSE). See
[SECURITY.md](SECURITY.md) to report a vulnerability.
