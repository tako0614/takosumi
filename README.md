# Takosumi

Takosumi is the source module that provides the OpenTofu-native deploy-control plane, the accounts plane, the dashboard,
the OpenTofu runner boundary, and the audit ledger for two in-process build targets:

- the operator-run Takosumi platform worker at `app.takosumi.com`;
- the self-hosted Takos product worker template, where Takosumi is embedded as an optional control-plane seam.

It installs plain OpenTofu modules into Spaces, records `source_sync` / `plan` / `apply` / `destroy` Runs, stores successful applies as `Deployment` records, and projects non-secret OpenTofu outputs as `OutputSnapshot`s.

Takosumi is consumed **in-process** through `tsconfig` aliases. There is no separate
`accounts.takosumi.com` / `deploy-control.takosumi.com` topology, and no npm-published service package. One operator
runs one Cloudflare worker serving the platform under `app.takosumi.com`; `takosumi.com` is the landing/docs site only.

Docs: <https://takosumi.com/docs/>

## In-process entry points

| Handler        | File                                                                  | Mount                                                                                   |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Account plane  | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`) | platform worker or takos worker origin root; issuer is the bare origin                  |
| Deploy control | `worker/src/handler.ts`                                               | `/api` and `/install` on the platform worker; in-process fetch seam in the takos worker |

`deploy/accounts-cloudflare/` stores account state in D1 and uses R2 only for metadata-only Installation export
artifacts. Cloudflare Container is not used by the account-plane path; it is used by the deploy-control runner for
OpenTofu `plan` / `apply`.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the same `createAccountsHandler` for the
local-substrate cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate
behind the one handler, not an alternate distribution.

## Public surface

The public concepts are **Space / Source / Connection / Installation / Dependency / Run / RunGroup / Deployment / OutputSnapshot / Activity** (see [AGENTS.md](AGENTS.md) "Public Surface" and [docs/reference/model.md](docs/reference/model.md) for the canonical definitions).

| Concept            | Meaning                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Space`            | Owner namespace (`@handle`) holding members, sources, connections, installations, the dependency graph, policy, activity, and optional billing.                                                |
| `Source`           | A registered git origin yielding immutable `SourceSnapshot`s (ref pinned to a commit, archived to R2 with digest).                                                                             |
| `Connection`       | An external connection (Git token / SSH key / Cloudflare token / AWS assume-role / static / manual) with `operator` or `space` scope; Installations bind capabilities per `CapabilityBinding`. |
| `OpenTofu Capsule` | A Git-hosted OpenTofu module-compatible configuration that Takosumi normalizes and calls from a generated root.                                                                                |
| `Installation`     | The Capsule + generated root + tfstate + output/deployment unit directly under a Space (`@space/name`), configured by a service-side `InstallConfig`.                                          |
| `Dependency`       | A DAG edge from a producer Installation's outputs to a consumer Installation's inputs, pinned at plan time by a `DependencySnapshot`.                                                          |
| `Run`              | One execution (`source_sync` / `plan` / `apply` / `destroy_plan` / `destroy_apply` …) with approval gate, plan digest, and policy status. `RunGroup` orders multiple Runs across the DAG.      |
| `Deployment`       | A successful apply with source snapshot, dependency snapshot, state generation, and output snapshot references.                                                                                |
| `OutputSnapshot`   | The `tofu output -json` generation captured after apply; the InstallConfig output allowlist projects `spaceOutputs` and `publicOutputs`.                                                       |
| `Activity`         | The Space-scoped audit trail.                                                                                                                                                                  |

Takosumi does not replace OpenTofu. OpenTofu owns resource graph, provider schema, state operation, and apply semantics. Takosumi records the reviewable and auditable control-plane layer around those operations.

## CLI quickstart

The in-repo operator CLI is `server` / `migrate` / `init` only (see [docs/reference/cli.md](docs/reference/cli.md)). It starts the local service and runs migrations / scaffold; it is not the canonical install/plan/apply flow.

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

`install` / `plan` / `apply` go through the dashboard and the [`/api`](docs/reference/deploy-control-api.md) control plane against a registered Source, not a CLI subcommand. Sources are plain git OpenTofu modules referenced by Git URL, commit, tag, and module path.

## Workspace

The current layout is `packages/*` (schema / graph / policy / rootgen / accounts-contract / accounts-service /
platform-services / cli), `worker/`, `runner-image/`, `opentofu-modules/`, `dashboard/`, `src/`
(service / runtime-agent / shared / cli), and `deploy/`. See the [AGENTS.md](AGENTS.md) "Workspace" section for the
annotated tree (single source of truth to avoid drift).

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run lint:json-ld
bun run docs:build
bun run website:build
```

## Docs and website

`docs/` is the VitePress docs site served under `/docs/`. `website/` is the landing page. `bun run website:build` produces one Cloudflare Pages artifact containing the landing page, `/docs/`, and `/contexts/`.
