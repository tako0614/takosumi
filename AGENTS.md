# AGENTS.md - Takosumi

This repository is **Takosumi**, an OpenTofu-native deploy control plane, UI, and audit ledger published as the single
npm package `@takosjp/takosumi`.

## Public v1 Surface

Takosumi public concepts are:

- `Installation`: Space-scoped installed OpenTofu module record with repository identity and current Deployment pointer.
- `Deployment`: successful apply result with commit/module identity, run links, status, and output snapshot.
- `PlanRun`: one OpenTofu plan attempt with reviewed plan artifact metadata, policy decision, runner profile, logs, and
  audit events.
- `ApplyRun`: one OpenTofu apply or destroy attempt with state backend reference, runner profile, status, logs, and
  audit events.
- `RunnerProfile`: operator-defined execution boundary for provider allowlists, credential references, state backend,
  execution image/resource limits, network policy, and Cloudflare Container execution.
- `DeploymentOutput`: public non-secret output projection derived from successful OpenTofu outputs. Sensitive outputs
  and secret references stay outside the public ledger.

Repositories are plain OpenTofu modules. Use Git URL, commit, tag, module path, and well-known OpenTofu outputs for
display, identity, and output projection.

## Runner Profile Boundary

Runner profiles own provider allowlists, credentials, state backends, execution image/resource limits, network policy,
and Cloudflare Container execution. Takosumi records plan / apply / destroy runs, installations, deployments, outputs,
policy decisions, logs, and audit trail. Credential values and secret outputs are never stored as public ledger values.

`takosumi` is the reference operator distribution. It composes the service app, injects stores/capabilities, owns
account-plane APIs, and exposes dashboard / billing / OIDC / deploy facade surfaces.

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        public deploy-control DTOs and internal reference contracts
│   ├── service/          reference service implementation
│   ├── runtime-agent/   internal compatibility code, not a public v1 subpath
│   ├── cli/             CLI implementation
│   └── all/             package subpath wrappers
├── docs/
├── website/
├── deploy/
├── fixtures/
└── scripts/
```

## Deploy Control API

The public API creates/imports Installations, creates PlanRuns, records approvals and policy decisions, creates
ApplyRuns for apply or destroy, and reads Deployments, DeploymentOutputs, logs, and audit events. API and CLI docs must
describe OpenTofu module repos and runner profiles.

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
- Keep account-plane features in operator distribution docs/code, not Takosumi.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
