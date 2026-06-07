# AGENTS.md - Takosumi

This repository is **Takosumi**, an OSS control plane that manages the **OpenTofu Capsule DAG directly under a
Space**. The product concept is "own Services in your Space instead of renting SaaS": users install OpenTofu Capsules
from any Git URL into a Space (`@handle`, an owner namespace close to a GitHub user/org), and Takosumi normalizes each
Capsule into a generated root, then manages plan / apply / destroy, state generations, outputs, the dependency DAG
between Installations, credentials, billing, and the audit trail. Features like Talk / Files / Blog are not built into
Takosumi — they enter as Git-URL Capsule Installations.

Takosumi is not a standalone npm-published service: its handlers are consumed **in-process** through `tsconfig`
aliases by **two build targets** — the operator's **Takosumi platform worker** (`deploy/platform/`, served at
`app.takosumi.com`, the only worker the operator deploys) and the **self-hosted Takos product worker**
(`takos/deploy/cloudflare/` template, served at the self-hoster's own origin). The `takosumi.com` apex is the
landing/docs site only; `takos.jp` is the Takos introduction site. Takos is complete as a plain OpenTofu module and
self-hosts with `tofu apply` + one wrangler step on its own infrastructure with no Takosumi required; installing that
same module into a Takosumi Space is optional, and Takos is just another plain OpenTofu module app to Takosumi, with no
special coupling.

`deploy/platform/` is the **platform worker's home**: it composes the accounts plane, the in-process control plane,
the dashboard SPA, and the OpenTofu runner container into the worker the operator runs at `app.takosumi.com`.
Its wrangler.toml is a placeholder reference template; the realized operator config (real resource IDs) lives in the
operator-private `takosumi-private` repo (state only — no code), which references this repo by relative path.

The two in-process entry points (consumed by both targets) are:

- `deploy/accounts-cloudflare/src/handler.ts` — account-plane handler (`createAccountsHandler`) mounted at the worker
  origin root. The issuer is the bare worker origin (`app.takosumi.com` for the platform worker, the self-hoster's own
  origin for a self-hosted takos worker); there is no `accounts.takosumi.com`.
- `worker/src/handler.ts` — control-plane handler. On the platform worker it serves the `/api` surface and
  the `/install` external install link; inside the takos product worker it is reached via the in-process fetch seam.
  There is no `deploy-control.takosumi.com`.

## Public Surface

Takosumi public concepts are **Space / Source / Connection / OpenTofu Capsule / Installation / Dependency / Run /
RunGroup / Deployment / OutputSnapshot / Billing / Activity**:

- `Space`: owner namespace (`@handle`) holding members, sources, connections, installations, the dependency graph,
  policy, activity, and optional billing. A personal Space is auto-created on first login.
- `Source`: a registered git origin (`url` / `defaultRef` / `defaultPath` / optional auth connection) yielding immutable
  `SourceSnapshot`s (ref pinned to a commit, archived to R2 with digest).
- `Connection`: an external connection (Git HTTPS token / Git SSH key / Cloudflare API token / AWS assume-role /
  static / manual) with `operator` or `space` scope. Installations bind capabilities
  (compute / dns / storage / source …) per `CapabilityBinding` (`default` / `connection` / `manual` / `disabled`);
  `default` resolves to the instance-wide operator default connections.
- `OpenTofu Capsule`: a Git-hosted OpenTofu module-compatible configuration that Takosumi can normalize and call from a
  generated root. User repositories stay plain OpenTofu; there is no Takosumi source manifest.
- `Installation`: the Capsule + generated root + tfstate + output/deployment unit directly under a Space (`@space/name`),
  configured by a service-side `InstallConfig` (trust level, capsule path, normalizer policy, variable mapping, output
  allowlist, policy). Legacy `installType` fields are compatibility implementation detail while runtime branching is
  retired.
- `Dependency`: a DAG edge from a producer Installation's outputs to a consumer Installation's inputs
  (`variable_injection` / `remote_state` / `published_output`), pinned at plan time by a `DependencySnapshot`
  (`strict` / `pinned`).
- `Run`: one execution (`source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` /
  `destroy_apply` …) with approval gate, plan digest, and policy status. `RunGroup` orders multiple Runs across the DAG
  (e.g. a Space update).
- `Deployment`: a successful apply with source snapshot, dependency snapshot, state generation, and output snapshot
  references.
- `OutputSnapshot`: the `tofu output -json` generation captured after apply; raw outputs stay encrypted artifacts and
  the InstallConfig output allowlist projects `spaceOutputs` and `publicOutputs`. Cross-Space sharing requires an
  explicit `OutputShare`.
- `Activity`: the Space-scoped audit trail.

Repositories are plain OpenTofu modules. Use Git URL, commit, tag, Capsule path, and well-known OpenTofu outputs for
display, identity, and output projection.

## Core Specification

The canonical Takosumi core spec is [`docs/core-spec.md`](docs/core-spec.md); adoption status lives in
[`docs/core-conformance.md`](docs/core-conformance.md). The spec governs the control plane's data model, the dependency
DAG, per-phase credential mint policy, and the security invariants. When this AGENTS file, reference docs, or
implementation conflict with the spec, the spec wins.

Two principles are load-bearing for new work:

- **GitHub-agnostic**: core knows only a `GitAddress` (`{ url, ref, path, credentialId? }`). Forge-specific identifiers
  (`githubInstallationId`, `githubRepoId`, `githubOwner`, `githubWebhookPayload`) must never enter core types; forge
  integrations are optional adapters outside core.
- **No in-repo manifest**: user repos stay plain git repos with no required Takosumi metadata file. All install
  configuration is service-side DB config (`InstallConfig`); repo metadata is read from Git and well-known OpenTofu
  outputs.

## Connection / Policy Boundary

Operator default connections and space connections own external credentials; Installations bind capabilities through
CapabilityBindings. Credential mint is decided **inside the vault** per run phase (source → git credential only,
build → none, plan/apply/destroy → provider credentials only) and never trusts caller claims. Policy evaluates the
Capsule Gate result and OpenTofu plan JSON in layers (space policy / InstallConfig trust / Capsule compatibility /
provider allowlist / module source policy / data-source allowlist / resource-type allowlist / scope boundary / action
policy / dependency policy / output policy / quota / billing reservation). The Cloudflare Container runner is the
security sandbox for git clone / normalize / gate / build / OpenTofu execution. Credential values and secret outputs
are never stored as public ledger values.

Billing machinery should be implemented as a Space-scoped ledger with operator-selected mode: `disabled` (self-host
default, no billing UI gate), `showback` (record estimates and usage without blocking apply), or `enforce` (hosted SaaS
credit reservation blocks approval/apply when insufficient).

## In-Process Composition

The control-plane and account-plane handlers are composed into the host worker (the operator's Takosumi platform worker
via `deploy/platform/`, and the self-hosted Takos product worker via `takos/deploy/cloudflare/`), not run as separate
services. The worker injects stores/capabilities and mounts the account-plane handler at the origin root. `/internal/*`
HTTP exists only for opentofu-runner / executor container callbacks.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the account-plane handler in the local-substrate
cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate for the same
`createAccountsHandler`, not an alternate distribution.

## Workspace

The worker/packages/runner physical restructure is **done**; this is the current layout. The remaining
`src/service/*` → `worker/src/modules/*` domain consolidation happens per-domain as each module is rewritten and is
tracked in the conformance doc (see its M1 row note).

```text
takosumi/
├── package.json
├── worker/
│   └── src/            single-Worker entry (index.ts / handler.ts / routes.ts), durable/ (CoordinationObject,
│                       OpenTofuRunnerObject), state crypto, D1 stores — the worker shell
├── packages/
│   ├── schema/         public control-plane DTOs / contracts (formerly src/contract)
│   ├── graph/          dependency-DAG topo / cycle rejection
│   ├── policy/         provider / resource / action policy layers
│   ├── rootgen/        generated OpenTofu root module
│   ├── accounts-contract/
│   ├── accounts-service/
│   ├── platform-services/
│   └── cli/
├── runner-image/       Dockerfile + entrypoint.ts + tofu.rc + provider mirror (Container runner image)
├── opentofu-modules/   official modules: core / cloudflare-worker-service / cloudflare-r2-storage /
│                       cloudflare-static-site / aws-s3-storage
├── dashboard/          dashboard SPA (SolidJS) build
├── src/
│   ├── service/        service implementation consumed in-process by the platform / product workers
│   │                   (domains/* still being consolidated into worker/src/modules/* per conformance M1)
│   ├── runtime-agent/  internal compatibility code, not a public subpath
│   ├── shared/         shared runtime primitives (subprocess)
│   └── cli/            CLI implementation
├── deploy/
│   ├── platform/              operator Takosumi platform worker (app.takosumi.com) build target
│   ├── accounts-cloudflare/   account-plane handler (in-process entry point)
│   ├── cloudflare/            control-plane handler + runner + container scaffold
│   ├── node-postgres/         Postgres substrate for the local-substrate cloud profile
│   ├── local-substrate/       local dev hostname stack
│   └── observability/
├── docs/
├── website/
├── fixtures/
└── scripts/
```

## Control Plane API

The control-plane handler registers Sources, creates Installations under a Space, creates plan Runs (pinning
SourceSnapshot + DependencySnapshot), records approvals and policy decisions, applies saved plans (verifying plan
digest / source snapshot / dependency snapshot / state generation), records StateSnapshot generations, OutputSnapshots,
and Deployments, marks downstream Installations stale, and reads runs, deployments, logs, and audit events. API and CLI
docs must describe OpenTofu Capsule repos, Installations, Dependencies, and Runs.

## Runtime Neutrality And Bun

Source is Bun-native TypeScript. Keep host-specific compatibility behind existing runtime-adapter/fetcher boundaries.
Service runtime primitives go through `src/service/shared/runtime/`.

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run lint:json-ld
```

## Work Rules

- Keep public contract changes in the contract layer (`packages/schema/`) and update docs/tests in the
  same change.
- Keep service-specific changes in the service layer (`src/service/`, consolidating into `worker/src/modules/` per
  conformance M1).
- Keep API and CLI docs aligned with Space, Source, Connection, Installation, InstallConfig, Dependency, Run, RunGroup,
  Deployment, and OutputSnapshot.
- Keep the control-plane and account-plane handlers consumable in-process by both build targets (the operator's Takosumi
  platform worker via `deploy/platform/` and the self-hosted Takos product worker via `takos/deploy/cloudflare/`); do not
  reintroduce standalone workers or `accounts.takosumi.com` / `deploy-control.takosumi.com` surfaces.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
