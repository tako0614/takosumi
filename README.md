# Takosumi

Takosumi is one OSS OpenTofu-native control plane. It provides deploy-control, accounts, dashboard, runner boundary, and
audit ledger code that can be composed in two contexts:

- the operator-run Takosumi platform worker at `app.takosumi.com`;
- the self-hosted Takos distribution worker, where the Takos product surface composes Takosumi accounts, deploy-control,
  dashboard, and runner boundaries in-process at the self-hoster's own origin.

It installs plain OpenTofu modules into Spaces, records `source_sync` / `plan` / `apply` / `destroy_plan` /
`destroy_apply` Runs, stores successful applies as `Deployment` records, and projects non-secret OpenTofu outputs as
`OutputSnapshot`s.

Takosumi handlers are consumed **in-process** through `tsconfig` aliases by the host worker. That is a composition
mechanism, not two different products. There is no retired split account/deploy-control host topology, and no
npm-published service package. One hosted operator runs one Cloudflare worker serving the platform under
`app.takosumi.com`; `takosumi.com` is the landing/docs site only.

Docs: <https://takosumi.com/docs/>

## In-process entry points

| Handler        | File                                                                  | Mount                                                                               |
| -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Account plane  | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`) | platform worker or takos worker origin root; issuer is the bare origin              |
| Deploy control | `worker/src/handler.ts`                                               | `/api` on the platform worker; typed in-process operations seam in the takos worker |

`/install?git=...&ref=...&path=...` is a dashboard SPA entrypoint, not a deploy-control handler. The SPA preserves the
query, forwards to `/new`, and only pre-fills the Git form; compatibility check and explicit confirmation still happen
inside `/new`.

`deploy/accounts-cloudflare/` stores account-plane state in D1. Installation backup/export artifacts belong to the
deploy-control backup/export flow and its R2 buckets, not to the account-plane ownership boundary. Cloudflare Container
is not used by the account-plane path; it is used by the deploy-control runner for OpenTofu `plan` / `apply`.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the same `createAccountsHandler` for the
local-substrate cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate
behind the one handler, not an alternate distribution.

## Public surface

The product flow is deliberately small: choose a **Space**, register a Git **Source**, bind provider **Connections**,
create an **Installation**, review a **Run**, then inspect the resulting **Deployment**, **OutputSnapshot**, and
**Activity**. `RunGroup` appears when Takosumi coordinates multiple Runs across the dependency graph. See
[AGENTS.md](AGENTS.md) "Public Surface" and [docs/reference/model.md](docs/reference/model.md) for the detailed model.

| Concept          | Meaning                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Space`          | Owner namespace (`@handle`) holding members, sources, connections, installations, the dependency graph, policy, activity, and optional billing.                       |
| `Source`         | A registered Git origin yielding immutable `SourceSnapshot`s (ref pinned to a commit, archived to R2 with digest).                                                    |
| `Connection`     | Sealed backing material for Git credentials, OAuth helpers, token-vending, or secret/env provider credentials. Provider execution binds through Provider Connections. |
| `Installation`   | The OpenTofu Capsule + generated root + tfstate + output/deployment unit directly under a Space (`@space/name`).                                                      |
| `Dependency`     | A DAG edge from a producer Installation's outputs to a consumer Installation's inputs, pinned at plan time by a `DependencySnapshot`.                                 |
| `Run`            | One execution (`source_sync` / `plan` / `apply` / `destroy_plan` / `destroy_apply` …) with approval gate, plan digest, policy status, logs, and audit events.         |
| `RunGroup`       | A grouped Space operation such as dependency-ordered update or drift check; not a separate deploy primitive.                                                          |
| `Deployment`     | A successful apply with source snapshot, dependency snapshot, state generation, and output snapshot references.                                                       |
| `OutputSnapshot` | The `tofu output -json` generation captured after apply; raw outputs stay encrypted and only allowlisted projections are shown.                                       |
| `Activity`       | The Space-scoped audit trail.                                                                                                                                         |

Provider Catalog, provider credential ownership, OpenTofu Capsule, Compatibility Report, InstallConfig, Installation
provider connection, Service Graph, StateSnapshot, Backup, and Billing are supporting API/operator concepts. They should
support the install/review/deploy outcome rather than become the first thing a user has to learn.

Takosumi does not replace OpenTofu. OpenTofu owns resource graph, provider schema, state operation, and apply semantics. Takosumi records the reviewable and auditable control-plane layer around those operations.

## Local control-plane quickstart

Run the local control-plane service directly when you want to exercise the `/api/v1` contract from curl or tests.
The CLI is documented separately in [docs/reference/cli.md](docs/reference/cli.md): the standard product flow is still
dashboard Git URL install, while `takosumi deploy` is the advanced local-upload helper.

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

Dashboard install / plan / apply go through the [`/api`](docs/reference/deploy-control-api.md) control plane against a
registered Git Source. `takosumi deploy` uses the same Run ledger for local upload snapshots before they are pushed to
Git.

## Workspace

The current layout is `contract/`, `core/`, `lib/`, `accounts/`, `providers/`, `worker/`, `runner/`,
`opentofu-modules/`, `dashboard/`, `website/`, and `deploy/`. See the [AGENTS.md](AGENTS.md) "Workspace" section for the
annotated tree (single source of truth to avoid drift).

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run docs:build
bun run website:build
```

## Docs and website

`docs/` is the VitePress docs site served under `/docs/`. `website/` is the landing page. `bun run website:build` produces one Cloudflare Pages artifact containing the landing page and `/docs/`.
