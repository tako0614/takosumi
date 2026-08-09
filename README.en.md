# Takosumi

日本語: [README.md](README.md)

Takosumi is an open-source server for safely running Git-hosted OpenTofu and
Terraform modules as a team.

Your existing modules and providers stay in place. Takosumi adds the workflow
around them:

- review a `plan`, then apply that exact plan
- record the commit, actor, time, and result of every run
- keep state, outputs, and logs for each run
- store cloud credentials and release them only to the active runner
- manage Git-hosted apps and infrastructure through a dashboard and API

There is no Takosumi-specific `.tf` syntax or first-party provider. Cloudflare,
AWS, Kubernetes, and other systems are still managed by their existing
providers.

[Software documentation](https://takosumi.com/docs/) ·
[Takosumi Cloud documentation](https://app.takosumi.com/docs/en/)

## Check it locally in five minutes

This short path starts the development API with in-memory storage. It requires
Bun and Git.

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

In another terminal, ask the server which features it exposes.

```bash
curl http://127.0.0.1:8788/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

This is an API check, not a production setup. Data disappears on restart, and
the dashboard and OpenTofu runner are not included. Follow the
[Quickstart](docs/en/getting-started/quickstart.md) to plan and apply a Git
module with the complete local stack.

## One Git/OpenTofu flow

The supported OSS user path is one Stack flow: run a Git module with the
providers it declares, using the shared run history, state, outputs, and audit
trail.

### Run a module from Git

This is the usual path.

1. Register a Git URL, ref, and module path.
2. Takosumi resolves the ref to one commit.
3. Create a plan and review the changes.
4. Apply the reviewed plan.
5. Save state, outputs, logs, and audit records.

Takosumi calls one registered module a **Capsule**. Knowing that term does not
change how you write the module.

A repository may optionally publish `.well-known/takosumi.json` to propose
Takosumi metadata pinned to the same commit. The current general `Repository`
envelope defines only `install.modules`; execution authority remains with the
DB-owned `InstallConfig`, Plan, and Run. See the
[Repository manifest reference](docs/en/reference/repository-manifest.md).

### Use providers

The supported OSS user path is the Git-based OpenTofu/Terraform Stack flow.
Takoform is an ordinary provider installed from
`registry.terraform.io/tako0614/takoform`, just like any other provider. The
Takoform definitions and any service that hosts and realizes Forms are not
owned by this repository.

Earlier experiments exposed `/v1/resources`, Resource Shape, a Form Host,
TargetPool, and SpacePolicy APIs and dashboard screens. They are not part of
the current OSS supported product surface. Retained compatibility APIs,
schemas, and persistence are migration internals; they are not user setup
instructions or dashboard navigation.

## Takosumi and Takosumi Cloud

- **Takosumi** is the software in this repository. You can operate it in your
  own environment.
- **Takosumi Cloud** is the official hosted service at `app.takosumi.com`.
  Hosted Forms/services, prices, capacity, and support are Cloud decisions.

The OSS software runs without the hosted service. Cloud pricing, Stripe, and
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
- [Operator runbooks](docs/operations/README.md)

## Development

```bash
bun run check
bun test
bun run docs:build
```

The main directories are `contract/` for public contracts, `core/` for the
control plane, `dashboard/` for the UI, `runner/` for execution, `deploy/` for
deployment compositions, and `docs/` for documentation.

This standalone OSS clone does not proxy hosted Cloud GA or production billing
operations.

Takosumi is licensed under [AGPL-3.0-only](LICENSE). See
[SECURITY.md](SECURITY.md) to report a vulnerability.
