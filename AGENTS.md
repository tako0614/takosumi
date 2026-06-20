# AGENTS.md - Takosumi

This repository is **Takosumi**, an OSS OpenTofu/Terraform control plane that runs existing provider ecosystems as-is.
Users register OpenTofu/Terraform modules from Git URLs as Capsules under a Workspace/Project, bind providers or aliases
to Provider Connections, run `tofu init` / `plan` / `apply` / `destroy`, and keep state, outputs, secrets, run history,
and audit evidence in Takosumi.

The authoritative product direction is [`docs/final-plan.md`](docs/final-plan.md). It supersedes older designs that
treated compatibility gateways, managed cloud resources, or Takosumi-provided provider-compatible endpoints as part of
the OSS control plane.

Takosumi OSS and Takosumi for Operators do **not** contain Cloudflare Compatibility Gateway, AWS/GCP compatibility APIs,
S3 gateway, Resource Driver system, Compat Pack system, Managed Edge / Storage / Container, official billing, official
quota, official usage metering, or official resource backends. Those are Takosumi Cloud-only closed features.

Takosumi is not a standalone npm-published service. It is one OSS control plane whose handlers are consumed
**in-process** through `tsconfig` aliases by host workers in two composition contexts: the operator's **Takosumi platform
worker** (`deploy/platform/`, served at `app.takosumi.com`, the only worker the operator deploys) and the
**self-hosted Takos distribution worker** (`takos/deploy/cloudflare/` template, served at the self-hoster's own origin).
The `takosumi.com` apex is the landing/docs site only; `takos.jp` is the Takos introduction site. Takos is the
first-party AI Workspace distribution: its self-host worker composes the Takos product surface with the embedded
accounts plane, deploy-control seam, dashboard, and OpenTofu runner boundary at the self-hoster's own origin.

`deploy/platform/` is the **platform worker's home**: it composes the accounts plane, the in-process control plane,
the dashboard SPA, and the OpenTofu runner container into the worker the operator runs at `app.takosumi.com`.
Its wrangler.toml is a placeholder reference template; the realized operator config (real resource IDs) lives in the
operator-private `takosumi-private` repo (state only — no code), which references this repo by relative path.

The two in-process entry points (consumed by both targets) are:

- `deploy/accounts-cloudflare/src/handler.ts` — account-plane handler (`createAccountsHandler`) mounted at the worker
  origin root. The issuer is the bare worker origin (`app.takosumi.com` for the platform worker, the self-hoster's own
  origin for a self-hosted takos worker); there is no dedicated accounts subdomain.
- `worker/src/handler.ts` — control-plane handler. On the platform worker it serves the `/api` surface and
  `/hooks/*` inbound webhook routes; inside the takos product worker it is reached via the in-process typed operations
  seam. There is no dedicated deploy-control subdomain. (The `/install` external install link is CLIENT-handled — a
  plain SPA path whose query the dashboard parses to pre-fill `/new`.)

## Public Surface

Takosumi's final customer-facing model is **Workspace / Project / Capsule / Source / ProviderConnection /
CredentialRecipe / ProviderBinding / Secret / Run / Plan / Apply / Destroy / StateVersion / Output / Runner /
AuditEvent / Operator**. Existing code may still contain Space / Installation / OutputSnapshot / Deployment /
Provider Catalog / `own_key` / `takos_provided` / Gateway names from the previous architecture. Treat those as migration
debt unless a change deliberately maps them to the Final Plan model.

- `Workspace`: user/team boundary for projects, provider connections, secrets, state isolation, and audit.
- `Project`: one product, service, application, or infrastructure group.
- `Capsule`: one OpenTofu/Terraform module execution unit, usually sourced from Git URL + ref + path.
- `Source`: Git URL / branch / ref / commit / subdirectory path / tarball / upload input.
- `ProviderConnection`: provider credential configuration stored in Takosumi and resolved into temporary env/file
  material only while a Run executes.
- `CredentialRecipe`: provider-specific env/file/pre-run action definition for running an existing Terraform/OpenTofu
  provider. This replaces the old compat-pack idea in OSS.
- `ProviderBinding`: provider address or alias to ProviderConnection mapping.
- `Secret`: encrypted backing material. Secret values are write-only to APIs and redacted from logs.
- `Run`: one init / validate / plan / apply / destroy / refresh / output execution with source snapshot, provider
  bindings, logs, outputs, state version, actor, and timestamps.
- `StateVersion`: persisted Capsule state generation.
- `Output`: captured `tofu output -json`, optionally wired into another Capsule's inputs.
- `Runner`: local/docker/remote/operator/cloud execution boundary for checkout, OpenTofu execution, log streaming,
  state sync, output extraction, and cleanup.
- `AuditEvent`: actor/action/target/result evidence.

Do not introduce compatibility gateway or managed resource concepts as OSS product nouns. Takosumi Cloud may implement
Cloud-only Provider Connections and Cloudflare compatibility outside the OSS control-plane contract.

Repositories are plain OpenTofu modules. Use Git URL, commit, tag, module path, and well-known OpenTofu outputs for
display, identity, and output projection.

## Core Specification

The product direction is [`docs/final-plan.md`](docs/final-plan.md). The existing core spec is
[`docs/core-spec.md`](docs/core-spec.md), and adoption status lives in [`docs/core-conformance.md`](docs/core-conformance.md).
Until those files are fully rewritten, treat Space / Installation / Gateway / `takos_provided` wording in them as
migration debt when it conflicts with the Final Plan.

Two principles are load-bearing for new work:

- **GitHub-agnostic**: core knows only a `GitAddress` (`{ url, ref, path, credentialId? }`). Forge-specific identifiers
  (`githubInstallationId`, `githubRepoId`, `githubOwner`, `githubWebhookPayload`) must never enter core types; forge
  integrations are optional adapters outside core.
- **No in-repo manifest**: user repos stay plain git repos with no required Takosumi metadata file. All install
  configuration is service-side DB config (`InstallConfig`); repo metadata is read from Git and well-known OpenTofu
  outputs.
- **Service Graph is output/projected state, not a manifest**: optional well-known OpenTofu outputs such as
  `service_exports` may help Takosumi project ServiceExport rows, but Capsule repos must not be required to adopt a
  Takosumi-specific manifest or DSL. Runtime authority is issued through ServiceGrant, not through output values.

## Provider Connection / Policy Boundary

Provider connections own the public provider selection boundary. Capsules bind providers through Provider Binding by
explicit ProviderConnection id. Cloudflare API tokens, AWS static keys, AWS AssumeRole, GCP service account JSON,
Hetzner tokens, S3-compatible credentials, and generic env values are all Provider Connection + Credential Recipe cases.

Credential mint/materialization is decided **inside the vault/runner boundary** per run phase and never trusts caller
claims. Source checkout receives only git credential material; plan/apply/destroy receive only the provider env/file
material required by the selected Credential Recipe. Temporary env values and credential files are deleted after the
run, and credential values / secret outputs are never stored as public ledger values.

Policy evaluates OpenTofu plan JSON in layers (workspace/project policy / capsule policy / provider allowlist /
provider connection policy / lockfile and mirror policy / module source policy / data-source allowlist / resource-type
allowlist / scope boundary / action policy / dependency policy / output policy / quota). The runner is the security
sandbox for git clone / build / OpenTofu execution.

Do not add OSS code paths that require Takosumi Gateway, Cloudflare WfP, managed resources, or Takosumi-issued
provider-compatible endpoints. If code needs that behavior, it belongs to Takosumi Cloud.

OSS operator quota/showback machinery should be implemented as a Workspace- or
Organization-scoped ledger with operator-selected mode: `disabled` (self-host
default, no billing UI gate) or `showback` (record estimates and usage without
blocking apply). Official billing, enforced payment gates, usage metering sold
as a service, and abuse/support workflows are Takosumi Cloud-only closed
features.

## In-Process Composition

The control-plane and account-plane handlers are composed into the host worker (the operator's Takosumi platform worker
via `deploy/platform/`, and the self-hosted Takos product worker via `takos/deploy/cloudflare/`), not run as separate
services. The worker injects stores/capabilities and mounts the account-plane handler at the origin root. `/internal/*`
HTTP route families are not customer APIs; they are reserved for opentofu-runner / executor container callbacks,
host-internal deploy-control seams, and operator hardening gates. OSS Takosumi does not expose provider-compatible
Gateway bridges, provider `base_url` endpoints, or Gateway run-key exchange routes; those belong to closed Takosumi
Cloud modules.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the account-plane handler in the local-substrate
cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate for the same
`createAccountsHandler`, not an alternate distribution.

## Workspace

The worker / core / providers / runner physical restructure is **done**; this is the current layout. Service domains
now live under `core/`, provider-specific code under `providers/`, reusable domain libraries under `lib/`, and the
single CLI under `accounts/cli/`.

```text
takosumi/
├── package.json
├── worker/
│   └── src/            single-Worker entry (index.ts / handler.ts / routes.ts), durable/ (CoordinationObject,
│                       OpenTofuRunnerObject), state crypto, D1 stores — the worker shell
├── contract/           public control-plane vocabulary: DTOs / contracts (the wire shape)
├── core/               provider-AGNOSTIC control plane: api/ + domains/* (sources, installations, runs,
│                       deploy-control, policy) + adapters/. Reads per-provider data only through the
│                       @takosumi/providers registry boundary, never inlined literals.
├── providers/          per-provider runtime implementations + the single-source registry:
│   ├── registry.ts     PROVIDER_RUNTIMES (identity / connection kinds / network policy / hosting /
│   │                   capsule module ids / runner profile) + types.ts (alias @takosumi/providers)
│   ├── cloudflare/      connection + credential drivers, WfP / current Cloudflare bridge hosting worker, modules/<id>/
│   ├── aws/             connection + credential drivers, modules/<id>/
│   ├── git/             git credential driver
│   └── generic-env-provider/  Generic env provider credential driver
├── lib/
│   ├── graph/          dependency-DAG topo / cycle rejection
│   ├── policy/         provider / resource / action policy layers
│   └── rootgen/        generated OpenTofu root module
├── accounts/           account-plane (contract / service / platform-services / cli)
├── runner/             Dockerfile + entrypoint.ts + tofu.rc + provider mirror (Container runner image)
├── opentofu-modules/   provider-agnostic `core` base-installation module + the shared bundled-HCL catalog
│                       (module-files.ts). Provider-specific Capsule modules live under
│                       providers/<provider>/modules/<id>/; the id+version registry is
│                       core/domains/templates/registry.ts.
├── dashboard/          dashboard SPA (SolidJS) build
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

The control-plane handler registers Sources, creates Capsules under a Workspace
/ Project, attaches ProviderBindings, creates plan Runs (pinning source
identity, provider lock, ProviderBindings, injected-env metadata, and policy
decision), records approvals, applies saved plans (verifying plan digest,
source identity, ProviderBindings, and state generation), records StateVersion
and Output generations, marks downstream Capsule inputs stale when
output-to-input wiring depends on them, and reads runs, logs, outputs, state,
and audit events. API and CLI docs must describe OpenTofu/Terraform Capsule
repos, ProviderConnection / CredentialRecipe / ProviderBinding, Runs,
StateVersion, and Output.

## Runtime Neutrality And Bun

Source is Bun-native TypeScript. Keep host-specific compatibility behind existing runtime-adapter/fetcher boundaries.
Service runtime primitives go through `core/shared/runtime/`.

## Commands

```bash
bun run check
bun test
bun run test:scripts
```

## Work Rules

- Keep public contract changes in the contract layer (`contract/`) and update docs/tests in the
  same change.
- Keep service-specific changes in the service layer (`core/`) and worker shell changes in `worker/`.
- Keep API and CLI docs aligned with Workspace, Project, Capsule, Source,
  ProviderConnection, CredentialRecipe, ProviderBinding, Secret, Run, Plan,
  Apply, Destroy, StateVersion, Output, Runner, AuditEvent, and Operator.
- Keep the control-plane and account-plane handlers consumable in-process by both build targets (the operator's Takosumi
  platform worker via `deploy/platform/` and the self-hosted Takos product worker via `takos/deploy/cloudflare/`); do not
  reintroduce standalone workers or retired split account/deploy-control host surfaces.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
