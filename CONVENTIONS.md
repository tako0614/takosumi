# Takosumi Conventions

Takosumi v1 is OpenTofu-native. A repository is installed as a plain OpenTofu
module using generic repository metadata; it does not carry a Takosumi-specific
metadata file, component graph, provider selector, or repository metadata field.

## Public Words

- `Space`: owner namespace (`@handle`) for members, Sources, Connections,
  Installations, the dependency DAG, policy, activity, and billing.
- `Source`: Git URL / default ref / module path record that yields immutable
  SourceSnapshots.
- `Connection`: sealed backing material for Git credentials, OAuth helpers,
  token-vending, or secret/env provider credentials.
- `Provider Connection`: public provider ownership selection. Each required
  provider source and optional alias resolves to `own_key` or `takos_provided`.
- `Provider Env`: internal provider resolver record used by vault/runner. It may
  materialize through `gateway`, `oauth`, or `secret`, but its `envId` is not
  public `/api/v1` vocabulary.
- `Provider Catalog`: provider source / helper / coverage / policy catalog.
  Hosted Gateway-backed (`takos_provided`) default starts
  Cloudflare-only.
- `Installation provider connection`: Installation/environment scoped provider
  binding, resolving each provider source and optional alias to a concrete
  public Provider Connection.
- `Installation`: Space-scoped OpenTofu Capsule execution unit.
- `Dependency`: output-to-input edge between Installations.
- `Run`: persisted source_sync / compatibility_check / plan / apply /
  destroy_plan / destroy_apply execution record.
- `RunGroup`: ordered group of Runs across the Installation DAG.
- `Deployment`: one successful apply result with source snapshot, dependency
  snapshot, state generation, output snapshot, and status.
- `OutputSnapshot`: projected `tofu output -json` generation after apply.
- `Activity`: Space-scoped audit trail.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Do not
add a new Takosumi public selector DSL.

## Operator Execution Boundary

Operator distributions own internal execution profiles, provider credential
mint drivers, OpenTofu state storage, runtime attachment, approval gates, and
account-facing policy. A distribution may populate policy from OpenTofu modules,
static config, cloud APIs, dashboard input, or private ops inventory. Takosumi
records policy decisions, Run evidence, Deployment, and OutputSnapshot records;
it does not expose provider credential values.

Backend adapters and runner implementations live in the operator distribution.
Those exports are distribution-local API, not Takosumi source authoring
vocabulary.

## Source And Build

Build recipes stay outside Takosumi. CI or an operator build service calls the
Deploy Control API to create an Installation plan Run from a Git URL /
SourceSnapshot, module path, variables, dependencies, and resolved internal
execution policy. Apply uses the saved plan and verifies plan digest, source
snapshot, dependency snapshot, compatibility report, and state generation to
prevent drift between review and execution.

## Test / Source Boundary

Test code is test-only even when it is physically close to the source it
exercises. Takosumi keeps that boundary with these rules:

- Test entry files live under the top-level `tests/` tree and use
  `*_test.ts` / `*_test.tsx`.
- Test paths mirror the source path they exercise, for example
  `tests/core/domains/deploy-control/mod_test.ts` tests
  `core/domains/deploy-control/mod.ts`.
- Shared test helpers live under `tests/helpers/`. If product code needs the
  helper, promote it to a normal source module with a clear owning domain.
- Production source must not import `bun:test`, `*_test.ts`, `*.test.ts`,
  `*.spec.ts`, `__tests__/`, `test/`, or `tests/`.
- Production `tsconfig` profiles exclude test-only files and directories.
- `bun run check:test-source-boundary` is the guard that enforces this
  separation before the normal type/build gates run.
