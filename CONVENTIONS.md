# Takosumi Conventions

Takosumi v1 is OpenTofu-native. A repository is installed as a plain OpenTofu
module using generic repository metadata; it does not carry a Takosumi-specific
metadata file, component graph, provider selector, or repository metadata field.

## Public Words

- `Workspace`: user/team owner boundary for projects, provider connections,
  secrets, state isolation, and audit.
- `Project`: one product, service, application, or infrastructure group.
- `Capsule`: one OpenTofu/Terraform module execution unit, usually sourced from
  Git URL + ref + path.
- `Source`: Git URL / branch / ref / commit / module path. Upload or
  prepared-source archives are internal/operator compatibility only.
- `ProviderConnection`: provider credential configuration stored in Takosumi and
  resolved into temporary env/file material only while a Run executes.
- `CredentialRecipe`: provider-specific env/file/pre-run action definition for
  running an existing OpenTofu/Terraform provider as-is.
- `ProviderBinding`: provider address or alias to ProviderConnection mapping.
- `Secret`: encrypted backing material. Secret values are write-only to APIs and
  redacted from logs.
- `Run`: one init / validate / plan / apply / destroy / refresh / output
  execution record with source snapshot, provider bindings, logs, outputs,
  state version, actor, and timestamps.
- `StateVersion`: persisted Capsule state generation.
- `Output`: captured `tofu output -json`, optionally wired into another
  Capsule's inputs.
- `Runner`: local/docker/remote/operator/cloud execution boundary for checkout,
  OpenTofu execution, log streaming, state sync, output extraction, and cleanup.
- `AuditEvent`: actor/action/target/result evidence.
- `Operator`: the person or organization running Takosumi for their own users.

Legacy names such as Space, Installation, Deployment, OutputSnapshot,
RunGroup, Activity, Provider Catalog, `own_key`, `takos_provided`, and
pre-v1 provider endpoint wording may appear only when documenting migration or
internal compatibility with older implementation names. Do not present them as
the current public product surface.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Do not
add a new Takosumi public selector DSL.

## Operator Execution Boundary

Operator distributions own internal execution profiles, provider credential
mint drivers, OpenTofu state storage, runtime attachment, approval gates, and
account-facing policy. A distribution may populate policy from OpenTofu modules,
static config, cloud APIs, dashboard input, or private ops inventory. Takosumi
records policy decisions, Run evidence, StateVersion, Output, and AuditEvent
records; it does not expose provider credential values.

Backend adapters and runner implementations live in the operator distribution.
Those exports are distribution-local API, not Takosumi source authoring
vocabulary.

## Source And Build

Build recipes stay outside Takosumi. CI, release automation, or the app's
OpenTofu module can publish or reference build artifacts as ordinary variables
and provider resources. Takosumi creates a Capsule plan Run from a Git Source,
module path, variables, ProviderBindings, output-to-input wiring, and resolved
internal execution policy. Apply uses the saved plan and verifies plan digest,
source identity, ProviderBindings, and state generation to prevent drift between
review and execution.

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
