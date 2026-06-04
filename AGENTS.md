# AGENTS.md - Takosumi

This repository is **Takosumi**, the source module that provides the accounts plane and the OpenTofu-native
deploy-control plane (plus UI surfaces and the audit ledger) for the single Takos worker. Takosumi is not a standalone
service and is not npm-published: its handlers are consumed **in-process** by the takos worker through `tsconfig`
aliases. There is one operator and one Cloudflare worker serving everything under `app.takosumi.com`; the
`takosumi.com` apex is the landing/docs site only.

The two in-process entry points are:

- `deploy/accounts-cloudflare/src/handler.ts` — account-plane handler (`createAccountsHandler`) mounted at the worker
  origin root. The issuer is the bare origin; there is no `accounts.takosumi.com`.
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

## Runner Profile Boundary

Runner profiles own provider allowlists, credentials, state backends, execution image/resource limits, network policy,
and Cloudflare Container execution. Takosumi records plan / apply / destroy runs, installations, deployments, outputs,
policy decisions, logs, and audit trail. Credential values and secret outputs are never stored as public ledger values.

## In-Process Composition

The deploy-control and account-plane handlers are composed into the takos worker, not run as separate services. The
worker injects stores/capabilities, mounts the account-plane handler at the origin root, and reaches deploy-control
through the in-process fetch seam. `/internal/*` HTTP exists only for opentofu-runner / executor container callbacks.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the account-plane handler in the local-substrate
cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate for the same
`createAccountsHandler`, not an alternate distribution.

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        public deploy-control DTOs and internal reference contracts
│   ├── service/         service implementation consumed in-process by the takos worker
│   ├── runtime-agent/   internal compatibility code, not a public v1 subpath
│   ├── cli/             CLI implementation
│   └── all/             package subpath wrappers
├── deploy/
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
- Keep the deploy-control and account-plane handlers consumable in-process by the takos worker; do not reintroduce
  standalone workers or `accounts.takosumi.com` / `deploy-control.takosumi.com` surfaces.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
