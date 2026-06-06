# AGENTS.md - Takosumi

This repository is **Takosumi**, the source module that provides the accounts plane and the OpenTofu-native
deploy-control plane (plus UI surfaces and the audit ledger). Takosumi is not a standalone service and is not
npm-published: its handlers are consumed **in-process** through `tsconfig` aliases by **two build targets** — the
operator's **Takosumi platform worker** (`deploy/platform/`, served at `app.takosumi.com`, the only worker the operator
deploys) and the **self-hosted Takos product worker** (`takos/deploy/cloudflare/` template, served at the self-hoster's
own origin). The `takosumi.com` apex is the landing/docs site only; `takos.jp` is the Takos introduction site. Takos is
complete as a plain OpenTofu module and self-hosts with `tofu apply` + one wrangler step on its own infrastructure with
no Takosumi required; running that same module through Takosumi is an optional convenience that adds the Installation /
run ledger / dashboard. Takos is just another plain OpenTofu module app to Takosumi, with no special coupling.

`deploy/platform/` is the **platform worker's home**: it composes the accounts plane, the in-process deploy-control
plane, the dashboard SPA, and the OpenTofu runner container into the worker the operator runs at `app.takosumi.com`.
Its wrangler.toml is a placeholder reference template; the realized operator config (real resource IDs) lives in the
operator-private `takosumi-private` repo (state only — no code), which references this repo by relative path.

The two in-process entry points (consumed by both targets) are:

- `deploy/accounts-cloudflare/src/handler.ts` — account-plane handler (`createAccountsHandler`) mounted at the worker
  origin root. The issuer is the bare worker origin (`app.takosumi.com` for the platform worker, the self-hoster's own
  origin for a self-hosted takos worker); there is no `accounts.takosumi.com`.
- `deploy/cloudflare/src/handler.ts` — deploy-control handler mounted via the worker's in-process fetch seam. It owns
  the Installation/run ledger and has no public routes; there is no `deploy-control.takosumi.com`.

## Public v1 Surface

Takosumi public concepts are:

- `Installation`: Space-scoped installed OpenTofu module record with repository identity and current Deployment pointer.
- `Deployment`: successful apply result with commit/module identity, run links, status, and output snapshot.
- `PlanRun`: one OpenTofu plan attempt with reviewed plan artifact metadata, policy decision, runner profile, logs, and
  audit events.
- `ApplyRun`: one OpenTofu apply or destroy attempt with state backend reference, runner profile, status, logs, and
  audit events.
- `RunnerProfile`: execution boundary for provider allowlists, credential references, state backend, execution
  image/resource limits, network policy, and Cloudflare Container execution.
- `DeploymentOutput`: public non-secret output projection derived from successful OpenTofu outputs. Sensitive outputs
  and secret references stay outside the public ledger.

Repositories are plain OpenTofu modules. Use Git URL, commit, tag, module path, and well-known OpenTofu outputs for
display, identity, and output projection.

## Core Specification

The canonical Takosumi core spec is [`docs/core-spec.md`](docs/core-spec.md); adoption status lives in
[`docs/core-conformance.md`](docs/core-conformance.md). The spec governs the deploy control plane's data model,
per-phase credential mint policy, and the 15 security invariants. When this AGENTS file, reference docs, or
implementation conflict with the spec, the spec wins.

Two principles are load-bearing for new work:

- **GitHub-agnostic**: core knows only a `GitAddress` (`{ url, ref, path, credentialId? }`). Forge-specific identifiers
  (`githubInstallationId`, `githubRepoId`, `githubOwner`, `githubWebhookPayload`) must never enter core types; forge
  integrations are optional adapters outside core.
- **No in-repo manifest**: user repos stay plain git repos with no required Takosumi metadata file. All install
  configuration is service-side DB config; repo metadata is read from Git and well-known OpenTofu outputs.

Core vocabulary for source-and-install modeling is **Source / App / Environment / InstallProfile** (with
DeploymentProfile + ConnectionBinding): a `Source` is a registered git origin that yields snapshots; an `App` binds a
Source to one install type (`app_source` / `opentofu_module` / `opentofu_root`); an `Environment` is one execution
target carrying an `InstallProfile`, a DeploymentProfile, connection bindings, and a current Deployment pointer. The
existing run-ledger surface (`Installation` / `PlanRun` / `ApplyRun` / `Deployment` / `DeploymentOutput`) remains the
public deploy-control vocabulary and maps onto these core concepts.

## Runner Profile Boundary

Runner profiles own provider allowlists, credentials, state backends, execution image/resource limits, network policy,
and Cloudflare Container execution. Takosumi records plan / apply / destroy runs, installations, deployments, outputs,
policy decisions, logs, and audit trail. Credential values and secret outputs are never stored as public ledger values.

## In-Process Composition

The deploy-control and account-plane handlers are composed into the host worker (the operator's Takosumi platform worker
via `deploy/platform/`, and the self-hosted Takos product worker via `takos/deploy/cloudflare/`), not run as separate
services. The worker injects stores/capabilities, mounts the account-plane handler at the origin root, and reaches
deploy-control through the in-process fetch seam. `/internal/*` HTTP exists only for opentofu-runner / executor container
callbacks.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the account-plane handler in the local-substrate
cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate for the same
`createAccountsHandler`, not an alternate distribution.

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        public deploy-control DTOs and internal reference contracts
│   ├── service/         service implementation consumed in-process by the platform / product workers
│   ├── runtime-agent/   internal compatibility code, not a public v1 subpath
│   └── cli/             CLI implementation
├── deploy/
│   ├── platform/              operator Takosumi platform worker (app.takosumi.com) build target
│   ├── accounts-cloudflare/   account-plane handler (in-process entry point)
│   ├── cloudflare/            deploy-control handler + runner + container scaffold
│   ├── node-postgres/         Postgres substrate for the local-substrate cloud profile
│   ├── local-substrate/       local dev hostname stack
│   └── observability/
├── docs/
├── website/
├── fixtures/
└── scripts/
```

## Deploy Control API

The deploy-control handler creates/imports Installations, creates PlanRuns, records approvals and policy decisions,
creates ApplyRuns for apply or destroy, and reads Deployments, DeploymentOutputs, logs, and audit events. API and CLI
docs must describe OpenTofu module repos and runner profiles.

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

- Keep public contract changes in `src/contract/` and update docs/tests in the same change.
- Keep service-specific changes in `src/service/`.
- Keep API and CLI docs aligned with OpenTofu module repo, PlanRun, ApplyRun, RunnerProfile, and DeploymentOutput.
- Keep the deploy-control and account-plane handlers consumable in-process by both build targets (the operator's Takosumi
  platform worker via `deploy/platform/` and the self-hosted Takos product worker via `takos/deploy/cloudflare/`); do not
  reintroduce standalone workers or `accounts.takosumi.com` / `deploy-control.takosumi.com` surfaces.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
