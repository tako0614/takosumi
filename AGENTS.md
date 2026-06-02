# AGENTS.md - Takosumi

This repository is **Takosumi**, a manifestless source-to-deployment substrate published as the single npm package
`@takosjp/takosumi`.

## Public v1 Surface

Takosumi public concepts are:

- `Source`: git / prepared / local source input and resolved source identity.
- `Installation`: Space-scoped installed source record.
- `Deployment`: one apply result with source summary, install plan snapshot, binding snapshot, outputs, and status.
- `PlatformService`: operator-catalog service capability selected during install or deploy.

There is no Takosumi-specific source metadata file in v1. Do not add Takosumi-specific repository metadata fields. Use generic repo
metadata such as Git URL, commit, tag, and `package.json` for display and identity hints.

Dry-run returns an `InstallPlan` and `planSnapshotDigest`. The plan is not a persisted public entity. Apply records the
plan snapshot and binding snapshot on Deployment.

## Operator Boundary

Takosumi does not run Terraform/OpenTofu, own provider state, or manage backend credentials. Operator distributions
own infra materialization and may use Terraform output, HCP Stacks publish output, remote state, cloud APIs, or static
config to populate PlatformService inventory.

`takosumi` is the reference operator distribution. It composes the service app, injects stores/capabilities, owns
account-plane APIs, and exposes dashboard / billing / OIDC / deploy facade surfaces.

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        public DTOs and reference SDK types
│   ├── installer/       source fetchers and Installer API client
│   ├── service/          reference service implementation
│   ├── runtime-agent/   runtime-agent host and lifecycle wire
│   ├── cli/             CLI implementation
│   └── all/             package subpath wrappers
├── docs/
├── website/
├── deploy/
├── fixtures/
└── scripts/
```

## Installer API

The public Installer API is five endpoints:

- `POST /v1/installations/dry-run`
- `POST /v1/installations`
- `POST /v1/installations/{id}/deployments/dry-run`
- `POST /v1/installations/{id}/deployments`
- `POST /v1/installations/{id}/rollback`

Use `409 failed_precondition` for source pin, prepared digest, current pointer, or `planSnapshotDigest` guard conflicts.
Use `413 resource_exhausted` for request or source size limits. The v1 surface does not use a caller-supplied
Idempotency-Key header.

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
- Keep source fetch / Installer API client behavior in `src/installer/`.
- Keep account-plane features in operator distribution docs/code, not Takosumi.
- Keep Terraform/OpenTofu ownership outside Takosumi.
- Retired v0 source-DSL vocabulary must not be reintroduced as public v1 doctrine.
