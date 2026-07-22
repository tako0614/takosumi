# AGENTS.md - Takosumi

This repository is **Takosumi**, an OSS Git-based OpenTofu control plane.
Takosumi can run existing OpenTofu/Terraform provider ecosystems as-is, and it
is an optional Service Form host. It owns the canonical Resource lifecycle,
Resolver / Planner / Runner / Reconciler,
Target / Credential / OIDC / Secret / Policy, the shared Interface /
InterfaceBinding API, the generic noncommercial Offering catalog / resolver /
selection engine, Compatibility API framework, and Adapter system described
in `docs/internal/final-plan.md`. The current Resource Shape API/provider/state
is a migration compatibility surface. Portable Service Form / FormRef /
data-only Form Package / typed form-provider / interoperability/conformance
authority moves to an independent OSS project after its public identity gates.

The authoritative product direction is [`docs/internal/final-plan.md`](docs/internal/final-plan.md). It supersedes older designs that made
all compatibility APIs Cloud-only. The new boundary is:

```text
OSS:
  framework and portable API

Operator / Cloud:
  commercial operation and official managed capacity
```

Takosumi OSS can define compatibility API framework, compatibility profiles,
Form Registry/FormActivation host contracts, the open exact Offering catalog/resolver/selection contract,
adapter contracts, target capability model, OIDC/workload
identity, and usage-event emission. Takosumi for Operator / Cloud owns
commercial customer management, rated billing, payment enforcement, invoices,
official managed target pools, official Takosumi native resource internals,
support/SLA, and abuse controls.

`takosumi-cloud/` (this repo's sibling) is the closed official hosted operation.
It may depend on the public contract and composition root, but it must not reach
into `takosumi/core` or `takosumi/accounts` internals as a private shortcut.

Takosumi is not a standalone npm-published service. It is one OSS control plane whose handlers are composed
**in-process** through `tsconfig` aliases into the operator's **Takosumi platform worker** (`deploy/platform/`). The
operator serves that worker at an explicit origin; the official Cloud deployment uses `app.takosumi.com`, while a
self-hoster uses an origin they operate. The `takosumi.com` apex is the landing/docs site only; `takos.jp` is the Takos
introduction site.

The self-hosted Takos distribution worker (`takos/deploy/cloudflare/`) is a separate Takos product worker. It consumes
Takosumi contract source through aliases and connects to the self-hoster/operator Takosumi control plane as an external
OIDC client/resource server. It does not mount Accounts, deploy-control, dashboard, or runner handlers in-process.

`deploy/platform/` is the **platform worker's home**: it composes the accounts plane, the in-process control plane,
the dashboard SPA, and the OpenTofu runner container into the one platform worker the operator runs. The origin is
operator configuration; our official Takosumi Cloud deployment uses `app.takosumi.com`.
Its wrangler.toml is a placeholder reference template; the realized operator config (real resource IDs) lives in the
operator-private `takosumi-private` repo (state only — no code), which references this repo by relative path.

The two in-process entry points consumed by the Takosumi platform worker are:

- `deploy/accounts-cloudflare/src/handler.ts` — account-plane handler (`createAccountsHandler`) mounted at the platform
  worker origin root. The issuer is that bare operator origin (`app.takosumi.com` for official Cloud); there is no
  dedicated accounts subdomain.
- `worker/src/handler.ts` — control-plane handler serving the platform worker's `/api` surface and `/hooks/*` inbound
  webhook routes. There is no dedicated deploy-control subdomain. (The `/install` external install link is CLIENT-handled — a
  plain SPA path whose query the dashboard parses to pre-fill `/new`.)

## Public Surface

Takosumi has two authoring flows plus a shared runtime interaction layer. The OpenTofu Stack flow uses
Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe /
ProviderBinding / Secret / Run / Plan / Apply / Destroy / StateVersion / Output
/ Runner / AuditEvent / Operator. Plan / Apply / Destroy are not separate
ledgers or entities: they are guarded `RunType` operations recorded as `Run`
ledger entries.

The Service Form host flow adds ServiceForm / FormRef / FormPackage / Space /
Environment / Stack / Resource / FormRegistry / FormActivation / Profile /
Implementation / Target / TargetPool / Credential /
Policy / Adapter / ResolutionLock / NativeResource / Condition / Agent /
AgentPool. The shared layer adds Interface / InterfaceBinding / Principal /
Role / RoleBinding / ServiceAccount. `ResourceShape` remains the current
wire/API/provider/state alias. `Space` is
valid as a `takosumi.dev/v1alpha1` namespace/policy scope; it is not the old
pre-v1 Space / Installation ledger model. The old Installation /
OutputSnapshot / StateSnapshot / Deployment / Provider Catalog / `own_key` /
`takos_provided` / Gateway / Runtime Projection names are retired; do not reintroduce
them as current product nouns.

The generic availability layer adds `Offering`, `OfferingCatalog`,
`OfferingAvailability`, and `OfferingSelection`. It accepts open exact subject
types and contains no price, payment, private manager/capacity, SLA, or support.
Cloud attaches a closed `CommercialOfferingBinding` only after Core returns an
exact selection; it does not own a second catalog decision or selection engine.

- `Workspace`: user/team boundary for projects, provider connections, secrets, state isolation, and audit.
- `Project`: one product, service, application, or infrastructure group.
- `Capsule`: one OpenTofu/Terraform module execution unit, usually sourced from Git URL + ref + path.
- `Source`: Git URL / branch / ref / commit / subdirectory path. A runner may
  prepare a checked-out immutable snapshot inside its sandbox, but upload and
  artifact authoring are not alternate Capsule source authorities.
- `ProviderConnection`: provider credential configuration stored in Takosumi and resolved into temporary env/file
  material only while a Run executes.
- `CredentialRecipe`: provider-specific env/file/pre-run action definition for running an existing Terraform/OpenTofu
  provider. This replaces the old compat-pack idea in OSS.
- `ProviderBinding`: provider address or alias to ProviderConnection mapping.
- `Secret`: encrypted backing material. Secret values are write-only to APIs and redacted from logs.
- `Run`: one execution recorded as a single `Run` ledger entry carrying a `RunType` operation (init / validate / plan /
  apply / destroy / refresh / output) — so Plan / Apply / Destroy are Run operations, not separate ledgers or entities —
  with source snapshot, provider bindings, logs, outputs, state version, actor, and timestamps.
- `StateVersion`: persisted Capsule state generation.
- `Output`: captured `tofu output -json`, optionally wired into another Capsule's inputs.
- `Interface`: a Workspace-, Capsule-, or Resource-owned, namespaced runtime contract with an arbitrary non-secret JSON document,
  named resolved inputs, access policy, generation, provenance, and lifecycle status.
- `InterfaceBinding`: explicit authorization from an Interface id to a Principal, ServiceAccount, Capsule, or Resource, with permissions
  and a supported invocation-time credential delivery mode.
- `Runner`: local/docker/remote/operator/cloud execution boundary for checkout, OpenTofu execution, log streaming,
  state sync, output extraction, and cleanup.
- `AuditEvent`: actor/action/target/result evidence.

Repositories are plain OpenTofu modules. Runtime Interfaces use service-side configuration to reference any ordinary
root Output by name; repositories do not publish a reserved Takosumi object, manifest, schema, or credential through
Output.

## Core Specification

The product direction is [`docs/internal/final-plan.md`](docs/internal/final-plan.md). The core spec is
[`docs/internal/core-spec.md`](docs/internal/core-spec.md), and adoption status lives in [`docs/internal/core-conformance.md`](docs/internal/core-conformance.md).
Conformance to the Final Plan is tracked explicitly; legacy implementation is
migration debt, not authority for the contract. The old Space / Installation /
Gateway / `takos_provided` wording is retired, not a vocabulary to migrate toward.

Three principles are load-bearing for new work:

- **GitHub-agnostic**: core knows only a `GitAddress` (`{ url, ref, path, credentialId? }`). Forge-specific identifiers
  (`githubInstallationId`, `githubRepoId`, `githubOwner`, `githubWebhookPayload`) must never enter core types; forge
  integrations are optional adapters outside core.
- **No in-repo manifest**: user repos stay plain git repos with no required Takosumi metadata file. All Capsule
  configuration is service-side DB config. New Capsule-owned Interface declarations materialize from service-side
  `InstallConfig.interfaceBlueprints` (`materializedFrom: capsule_blueprint`) and are never inferred from Output names.
  Historical `capsule_resource` records remain operator cleanup custody, not a new authoring or authentication surface.
  A plain module requires no Takosumi manifest/provider. Separately, a Takoform Form Package may declare a required
  Interface descriptor that Takosumi materializes as a Resource-owned `form_descriptor`; it is not a Capsule source.
- **Service Form host API**: Service Form authoring is not repository metadata. Takosumi Core has zero implicit Form
  Packages and plain OpenTofu repos remain valid. `/v1/resources` is the current compatibility Deploy API and sole
  lifecycle authority for managed Resources; a future portable route must delegate to the same row/ledger.
  The mixed `takosumi/takosumi` provider is discontinued historical state custody. Takoform owns portable typed Forms
  and Form Package Interface descriptors; Takosumi API/CLI/dashboard owns operator administration. None owns host
  availability, backend selection, state, or pricing outside the canonical Takosumi lifecycle.
- **Compatibility profiles by capability**: S3 / OCI / CloudEvents / Kubernetes CRD surfaces are
  capability-versioned protocol surfaces for Takosumi-managed capabilities. Control-plane profiles translate into
  the Deploy API and own no lifecycle state; data-plane profiles resolve canonical Ready Resources. Resource adapters
  and backend managers never use compatibility handlers as their implementation. Do not claim complete provider API
  compatibility.
- **Shared Interface layer**: Workspace, Capsule, and Resource owners use the same Interface API. Core resolves only literal,
  `capsule_output`, and `resource_output` inputs; type-specific JSON is validated by consumers. Interface changes do
  not schedule Workspace-wide reconciliation, and Resource `connections` remain adapter materialization contracts.
  New Capsule declarations come from service-side blueprints; historical `capsule_resource` custody never becomes a
  recommended module-author path and has no Capsule-scoped Run credential. Operators may inspect or retire those rows
  through the ordinary control API. Resource-owned Form descriptors are a separate provenance. InterfaceBinding
  authorization never becomes module or Form Package authority. A portable descriptor's `resource_uri` source is
  resolved by host code to a credential-free HTTPS audience and materialized as a non-secret literal input; it grants
  no access, and a missing resolver keeps a required descriptor fail-closed. Freshness beyond apply time is a status-plane channel
  (self-report / probe / refresh Run) that may update conditions only, never spec. The `document.display` consumer
  profile is defined once in the Final Plan / Core Spec and parsed through the shared contract-layer parser.
- **No secrets in Interface state**: Interface documents and resolved inputs never contain runtime credentials, and
  the Interface layer never writes them to Output, state, Run, logs, or audit. InterfaceBinding authorizes
  invocation-time OAuth, workload tokens, or an explicitly supported Secret materialization path; ordinary
  provider-managed sensitive state remains encrypted and ineligible for Interface resolution.

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
sandbox for source checkout, generated-root materialization, OpenTofu execution, state capture, output capture, and
cleanup. CI/release artifacts consumed and SHA-256-verified by the OpenTofu module are the default fast path. A Capsule
may instead opt into the structured `sourceBuild` runner contract: argv-only commands run against the pinned
SourceSnapshot without provider credentials and must produce declared relative paths before the OpenTofu child module
is materialized. Takosumi never infers build commands or turns repository metadata into executable authority; resource
creation remains owned by OpenTofu.

Do not hard-code Cloud-only edition branches into core. Add framework-level code behind capabilities and keep official
managed capacity, closed native-resource internals, and enforced billing in Operator/Cloud integration points.

OSS operator quota/showback machinery keeps Workspace / Capsule attribution but
uses an owner-account billing subject with operator-selected mode: `disabled`
(self-host default, no billing UI gate) or `showback` (record estimates and
usage without blocking apply). Official billing, enforced payment gates (the Stripe
`BillingEnforcement` Seam B port), usage metering sold as a service, and
abuse/support workflows are Takosumi Cloud-only closed features in
`takosumi-cloud/`.

## In-Process Composition

The control-plane and account-plane handlers are composed into the operator's Takosumi platform worker via
`deploy/platform/`, not run as separate services and not embedded in the Takos product worker. The platform worker
injects stores/capabilities and mounts the account-plane handler at the origin root. A self-hosted Takos worker consumes
that externally operated control plane over OIDC and contract-shaped HTTP APIs. `/internal/*`
HTTP route families are not customer APIs; they are reserved for opentofu-runner / executor container callbacks,
host-internal deploy-control seams, and operator hardening gates. Public compatibility routes must be explicit,
versioned capability surfaces such as `compat.s3.v1`, not hidden internal Gateway bridges.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the account-plane handler in the local-substrate
cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate for the same
`createAccountsHandler`, not an alternate distribution.

## Workspace

The worker / core / providers / runner physical restructure is **done**; this is the current layout. Service domains
now live under `core/`, provider-specific code under `providers/`, reusable domain libraries under `lib/`, and the
single operator/platform CLI under `cli/` (top-level, not part of the account plane).

```text
takosumi/
├── package.json
├── worker/
│   └── src/            single-Worker entry (index.ts / handler.ts / routes.ts), durable/ (CoordinationObject,
│                       OpenTofuRunOwnerObject, OpenTofuRunnerObject), state crypto, D1 stores — the worker shell
├── contract/           public control-plane vocabulary: DTOs / contracts (the wire shape)
├── core/               provider-agnostic control plane: api/ + domains/* (sources, Capsules, Runs,
│                       deploy-control, policy) + adapters/. Provider, target, and runner behavior is
│                       selected only by explicit open contracts, never by vendor-name inference.
├── providers/          optional provider-specific Connection/Credential Recipe helpers and modules:
│   ├── registry.ts     informational recipe/helper discovery; it is not execution authority
│   ├── cloudflare/      connection + credential drivers and explicitly selected modules
│   ├── aws/             connection + credential drivers, modules/<id>/
│   ├── git/             git credential driver
│   └── generic-env-provider/  Generic env provider credential driver
├── lib/
│   ├── graph/          dependency-DAG topo / cycle rejection
│   ├── policy/         provider / resource / action policy layers
│   └── rootgen/        generated OpenTofu root module
├── accounts/           account-plane (contract / service / platform-services)
├── cli/                operator/platform CLI (`takosumi` bin; accounts migrate / connections / Capsules /
│                       deploy / serve / platform readiness + secrets)
├── runner/             reference Docker runner + entrypoint.ts + tofu.rc + provider mirror; RunnerProfile
│                       remains substrate-open and does not make this image an implicit core default
├── opentofu-modules/   ordinary reusable OpenTofu modules. A module is installed through the same Git Source +
│                       child-module generated-root flow as any other Capsule; there is no privileged template registry.
├── dashboard/          dashboard SPA (SolidJS) build
├── deploy/
│   ├── platform/              operator Takosumi platform worker build target (official Cloud uses app.takosumi.com)
│   ├── accounts-cloudflare/   account-plane handler (in-process entry point)
│   ├── cloudflare/            control-plane handler + runner + container scaffold
│   ├── node-postgres/         Postgres substrate for the local-substrate cloud profile
│   ├── local-substrate/       local dev hostname stack
│   └── observability/
├── docs/               software / Operator docs for takosumi.com/docs
├── app-docs/           hosted Takosumi Cloud docs for app.takosumi.com/docs
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
and audit events. It also stores Workspace-, Capsule-, or Resource-owned Interfaces, resolves
their named public inputs after successful apply/refresh, records provenance and
conditions, and authorizes consumers through InterfaceBindings. API and CLI docs must describe OpenTofu/Terraform Capsule
repos, ProviderConnection / CredentialRecipe / ProviderBinding, Runs,
StateVersion, Output, Interface, and InterfaceBinding.

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
  Apply, Destroy, StateVersion, Output, Interface, InterfaceBinding, Runner,
  AuditEvent, and Operator.
- Keep the control-plane and account-plane handlers composed in-process by the operator's Takosumi platform worker via
  `deploy/platform/`; keep the self-hosted Takos product worker as an external OIDC/control-plane client. Do not
  reintroduce retired split account/deploy-control host surfaces or embed those services into the Takos worker.
- Do not add Deno; the Bun migration is in progress and Bun remains the default runtime/tooling direction.
