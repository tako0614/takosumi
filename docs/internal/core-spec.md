# Takosumi Core Spec

Last updated: 2026-07-14

This document describes the OSS core specification. Product direction is fixed
by [Takosumi Final Plan](./final-plan.md).

## Definition

Takosumi OSS is a Git-based OpenTofu control plane with resource-shape
resolution.

It supports two authoring flows and one shared runtime interaction layer:

```text
Flow A:
  plain OpenTofu/Terraform stack execution from Git

Flow B:
  provider-neutral Resource Shape deployed through /v1/resources

Shared layer:
  Workspace/Capsule/Resource Interface declaration and InterfaceBinding authorization
```

The current implementation is stronger in Flow A and is being extended toward
Flow B.

## Core Responsibilities

Takosumi Core owns:

```text
Git Source and immutable source snapshots
OpenTofu/Terraform init / validate / plan / apply / destroy
ProviderConnection
CredentialRecipe
ProviderBinding
run-scoped env/file injection
StateVersion storage and locking
Secret storage
Run ledger
Run logs
Output capture
Output-to-input wiring
Interface storage and input resolution
InterfaceBinding authorization
AuditEvent ledger
Runner protocol
policy and approval hooks
Resource Shape Deploy API (`/v1/resources` Resource lifecycle authority)
Target / TargetPool
Credential / OIDC / Workload Identity
Resolver / Planner / Reconciler
Adapter framework
Compatibility API framework
usage event emission
```

Takosumi Core does not own:

```text
commercial customer management
invoice / payment integration
rated billing and payment enforcement
official managed target capacity
official Takosumi native resource internals
official SLA / support / abuse tooling
```

Compatibility API framework is core; official managed capacity is not.

For Flow B, `/v1/resources` is the Deploy API and sole lifecycle authority.
Provider, CLI, dashboard, CRD, and control-plane compatibility clients submit
typed desired state to it. Core owns the canonical Resource, ResolutionLock,
NativeResource, Run, status, Output, and audit evidence. Adapters and backend
managers execute only after Deploy API resolution and do not own a parallel
resource registry.

## Public Model

### OpenTofu Stack Flow

| Concept            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Workspace          | User/team isolation boundary for projects, secrets, state, runs, and audit |
| Project            | One service, product, or infrastructure group                              |
| Capsule            | One OpenTofu/Terraform module execution unit                               |
| Source             | Git URL/ref/commit/path for a plain OpenTofu/Terraform module              |
| ProviderConnection | Stored provider credential configuration                                   |
| CredentialRecipe   | How to materialize a provider credential as env/file/pre-run output        |
| ProviderBinding    | Mapping from provider name/alias to ProviderConnection                     |
| Secret             | Encrypted material referenced by ProviderConnection or Capsule inputs      |
| Run                | One init/validate/plan/apply/destroy/refresh/output action                 |
| StateVersion       | Stored state generation for a Capsule                                      |
| Output             | Captured OpenTofu output value                                             |
| Runner             | Local/docker/remote/operator/cloud execution worker                        |
| AuditEvent         | Actor/action/target/result evidence                                        |

Plan / Apply / Destroy are guarded Run operations, not separate ledgers.

`Secret` here is the encrypted Stack-flow boundary, not a bundled Resource
Shape. In the current v1alpha1 composition, ProviderConnection registration
accepts write-only secret material, seals it at rest, and materializes it only
inside an authorized Run. A standalone Secret API/resource contract is not yet
defined. The candidate `Secret` Resource Shape in the Final Plan remains a
future shape and must not be added without its own typed schema, planner,
adapter, import/drift semantics, and tests.

#### OpenTofu Output Boundary

The baseline Stack flow captures `tofu output -json` as `Output` together with
the successful apply's `StateVersion`. Explicit Dependency wiring and
`terraform_remote_state` work independently of any Takosumi extension.

Output remains an ordinary root module return value. Takosumi does not require
a reserved Output name or a nested runtime schema. An Interface that needs a
public Output uses an explicit service-side `capsule_output` input reference to
the Capsule id, root Output name, and optional RFC 6901 JSON Pointer.

If the runner wraps the repository as a child module, generated-root
materialization re-exports each selected output without renaming or changing
its value/sensitivity metadata. If that contract cannot be preserved, the
repository module executes as the root. Ephemeral outputs are not captured and
cannot be Interface inputs; sensitive outputs may exist as OpenTofu values but
the Interface resolver rejects them.

Output changes do not schedule Workspace-wide reconciliation. Only an explicit
output-to-input Dependency marks a downstream Capsule stale. Runtime consumers
observe Interface `resolvedRevision` changes without applying their own
OpenTofu Capsule.

Migration from the retired runtime Output convention is an operator-reviewed,
one-time report/confirm operation. The report exposes Output names and digests,
never values. Known first-party Capsules materialize their service-side
InstallConfig Interface blueprints; unknown third-party Capsules require an
explicit owner selection of Output name and Interface type/version and are
never inferred from `service_exports`, `service_bindings`, or
`app_deployment`. Confirmation is fenced to the reviewed Capsule,
InstallConfig, current Output, names, and blueprint digest. It completes only
after the Interface resolves and durable names/digests-only Activity evidence
is written. A retry adopts the exact existing Interface and rewrites the same
deterministic evidence id; legacy discovery is never fallback authority.

#### Artifact Reference Boundary

`SourceSnapshot.archiveRef`, `StateVersion.stateRef`, `Output.rawArtifactRef`,
`ArtifactRecord.ref`, and backup pointer `ref` values are opaque coordinates
allocated by a host-injected `ArtifactReferenceAllocator`. Core passes the
allocated value unchanged to the runner/storage adapter and records it only
after that adapter confirms durable persistence. Core and the portable contract
do not derive bucket names, object-key layouts, filesystem paths, or URI schemes.
The Cloudflare adapter may interpret a ref as an R2 object key; another host may
map it to a filesystem, database, or remote artifact service without changing
the ledger contract.

### Shared Interface Layer

| Concept          | Meaning                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Interface        | Workspace-, Capsule-, or Resource-owned non-secret runtime contract and resolved public inputs           |
| InterfaceBinding | Explicit runtime authorization from an Interface id to a Principal, ServiceAccount, Capsule, or Resource |
| Principal        | Authenticated user or workload identity                                                                  |
| ServiceAccount   | Stable workload identity used for runtime authorization                                                  |

An Interface uses the standard Resource-style envelope
`apiVersion / kind / metadata / spec / status`, but it is shared by both
authoring flows and is not a Resource Shape. Its stable fields are:

```text
metadata:
  id / workspaceId / name / ownerRef(Workspace|Capsule|Resource) / generation / labels

spec:
  namespaced type / version
  arbitrary non-secret JSON document
  named inputs
  visibility / policyRef / authorization resource URI

status:
  phase / observedGeneration / resolvedRevision
  resolvedInputs / per-input provenance / conditions
```

Takosumi Core treats `document` as opaque JSON. Unknown type/version pairs are
stored and resolved; the consumer claiming support validates the document.
Interface resolution never executes templates, expressions, transforms, shell,
or HTTP fetches and never interpolates values into `document`. Consumers read
`document + resolvedInputs`.

For `mcp.server`, persisted documents contain transport/discovery metadata, not
a tool catalog. Takos obtains current server capabilities and tools through MCP
`initialize` and `tools/list` when it connects.

The only v1alpha1 input sources are:

```text
literal:
  explicitly configured non-secret JSON

capsule_output:
  same-Workspace Capsule id + ordinary root Output name + optional RFC 6901
  JSON Pointer

resource_output:
  same-Workspace Resource id + public output name + optional RFC 6901 JSON
  Pointer, Ready at its current generation
```

Each service-side Capsule Interface blueprint has an explicit immutable `key`
for one-shot materialization provenance. The editable Interface `name` is not a
fallback identity, and an unkeyed blueprint is invalid.

One resolution pass pins each referenced StateVersion or Resource generation.
Missing, null, sensitive, invalid-pointer, unavailable-generation, or cross-Workspace
references fail closed as `NotReady`; an old resolved value is not exposed as
current. A successful apply/refresh resolves only affected Interfaces and
atomically advances their resolved revision. Plan unknowns leave the current
revision unchanged with a pending condition. Apply failure marks affected
Interfaces `Unknown`; owner destroy moves them through `Terminating` to
`Retired` and stops/revokes runtime credential issuance.
Drift observation adds a `Drifted` condition without switching the pinned
resolved inputs; a successful refresh/apply is required to publish a new
revision.

The shipped Capsule lifecycle integration covers successful apply, uncertain
apply/restore failure fencing, destroy start/success, queued-plan observation,
and drift-check completion. A queued plan adds `ObservationPending` without
changing the pinned resolved revision or revoking an existing Ready Binding;
terminal observation clears only its matching condition, while a successful
drift check adds or clears `Drifted`. Implementations do not infer any of these
transitions from variable or Output names.

Runtime authorization derives Capsule safety from the durable Run ledger, not
only from best-effort lifecycle observers. Apply/restore uncertainty and
destroy state therefore fence both existing and newly created Interfaces,
including Workspace-owned Interfaces that reference Capsule Outputs. A Capsule
marked `stale` by Source update remains safe at its last successful pinned
revision. Runtime discovery hydrates only the requested Workspace and
idempotently repairs missed InstallConfig blueprint materialization. It also
replays Resource lifecycle from the durable Resource ledger for that Workspace,
repairing missed Ready, Unknown, Terminating, and Retired observer transitions
without an all-tenant startup scan.

Public CRUD is rooted at `/v1/interfaces`; bindings are rooted at
`/v1/interfaces/:id/bindings`. An authenticated runtime Principal requests an
invocation credential from `POST /v1/interfaces/:id/token` with one exact
`permission`. Spec writes and resolver status writes have separate
authorization. ETag/generation protects desired updates, while
resolvedRevision identifies observed input changes.

InterfaceBinding carries the Interface id, a Principal/ServiceAccount/Capsule/
Resource subjectRef, permissions, and an extensible delivery object. An exact
Principal binding with `delivery.type = none` is Ready when its Interface is
resolved. An exact Principal binding with `delivery.type = oauth2` is Ready
only when the host injected an Interface credential issuer, the delivery has
no credential reference/options, and `spec.access.resourceUriInput` resolves
a credential-free absolute HTTPS resource URI. An OAuth resource
authorizer must also prove that the Interface owner controls that URI's
hostname; a literal or Output URL is not ownership proof by itself.

The default OSS authorizer accepts only a Capsule owner with an active public
hostname reservation matching the same Workspace and Capsule. Custom/external
resources require an explicit host override; no proof means NotReady.

The token route reconciles lifecycle state and rechecks the exact Workspace,
Principal, permission, Ready Binding, Binding observation of the current
Interface revision, resolved resource audience, and host ownership proof
immediately before calling the issuer. Core rejects issuer results that are not
a non-empty Bearer or that expire more than 60 seconds after issuance. The OAuth-style response contains
`access_token`, `token_type`, `expires_in`, `expires_at`, `scope`, and
`resource`, is emitted with no-store headers, and has no refresh token. The raw
credential is never stored by Core or written to Interface, resolvedInputs,
Output/state, Run, logs, or audit; only non-secret issuance evidence is audited.

The Accounts-backed node and Worker compositions implement this issuer with an
opaque `taksrv_` token. Durable Accounts stores retain the hash plus the exact
subject, Workspace, Interface id, Binding id, resolved revision, audience,
scope, and expiry. `/oauth/userinfo` exposes an active token as
`/oauth/userinfo` and authenticated `/oauth/introspect` expose an active token
with `token_use = interface_oauth`, exact `aud` / `scope`, and the corresponding
`takosumi` Interface/Binding/revision evidence (plus the Capsule id for a
Capsule-owned Interface) so the target Capsule can fail closed. This is a host
composition of the generic OSS Core issuer port, not a Cloud-only credential
contract.

The Accounts introspection endpoint always requires a registered client;
Interface OAuth introspection also requires the exact resource URI. Platform
composition derives ordinary OAuth, personal access, and Interface OAuth
identity from explicit `token_use` claims, rejects unknown claims, and verifies
Interface audience/scope/evidence against the selected resource route. Opaque
token prefixes are not routing or authorization authority.

`delivery.type = workload_token` remains NotReady even when the Principal
OAuth issuer exists; its future identity is ServiceAccount, not a repurposed
human Principal. Secret-backed delivery, other subject/delivery combinations,
and a `policyRef` without a host policy evaluator also remain NotReady until
their explicit host authority exists. A static external credential can only be
referenced through Secret and materialized at an authorized invocation.
Provider-managed sensitive OpenTofu state remains encrypted and is ineligible
for Interface resolution.

### Resource Shape Flow

| Concept        | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| Space          | Resource API namespace and policy scope                                 |
| Environment    | Deployment environment within a Space/Project                           |
| Stack          | Git-backed OpenTofu stack or resource-shape bundle                      |
| Resource       | Kubernetes-like desired/observed resource object                        |
| ResourceShape  | Resource form such as EdgeWorker, ObjectBucket, or Queue                |
| Profile        | Ecosystem compatibility surface such as workers_bindings                |
| Implementation | Concrete backend such as cloudflare_workers or cloudflare_r2            |
| Target         | Southbound account/cluster/fleet/runtime endpoint                       |
| TargetPool     | Candidate targets used by the resolver                                  |
| Credential     | Target or workload credential configuration                             |
| Policy         | Constraints, approvals, lifecycle, and resolution rules                 |
| Adapter        | Code that previews/applies/imports/observes/refreshes an implementation |
| ResolutionLock | Persisted selected implementation + target                              |
| NativeResource | Concrete backend resource reference                                     |
| Condition      | Ready / Reconciling / Drifted / Degraded / Blocked evidence             |

`Space` in this model is the Resource API namespace and policy scope. The public
model uses Workspace / Project / Capsule / Run / StateVersion / Output /
Resource Shape / Target / Adapter plus the shared Interface / InterfaceBinding
layer.

Core does not infer a Space-to-Workspace mapping. In the stock multi-tenant
platform composition, a session, personal access token, service token, or OAuth
token may use the Resource Shape routes only with `space` equal to its verified
Workspace id. The platform worker checks every query/body/metadata Space
selector before replacing the external credential with its internal actor.
Operator calls carrying the direct deploy-control bearer remain the explicit
authority for managing another Space or implementing a future reviewed mapping.

## Git Source And Run Input Model

Takosumi's standard path runs the OpenTofu/Terraform module that lives in Git.

```text
Git URL + ref/tag/commit + module path
  -> checkout
  -> tofu init
  -> tofu plan
  -> tofu apply
```

The runner may persist an immutable `SourceSnapshot` archive for reproducible
plan/apply, but that snapshot is a copy of the Git module bytes selected by the
source ref. `Source.autoSync` may prepare a newer immutable source snapshot.
When the resolved Git commit differs from the SourceSnapshot currently applied
by an active Capsule that tracks the Source, Takosumi marks that Capsule
`stale`. The existing Workspace update / RunGroup flow can then create update
plans in dependency order. Apply remains reviewed by default. A Capsule may
explicitly opt into auto-update; only a clean non-destructive plan may continue
to apply automatically, while destructive changes always stop for review.

An explicit user update creates a SourceSyncRun with `manual_plan` intent,
waits for that Run's exact immutable SourceSnapshot, checks compatibility for
that snapshot, and pins the resulting report into the plan. This sync may mark
the Capsule stale, but it must not independently start a competing auto-update
plan/apply. Plan/apply remain ordinary OpenTofu Runs.

Takosumi does not decide app artifact semantics. If a module needs an image
reference, release tag, object key, URL, or digest, the module declares a normal
variable or provider/data-source logic.

## Install Store Experience Contract

The install Store is discovery and presentation only. A Store node announces
that a Git repository/path exists and can present icons and descriptions. It
does not own setup fields or release selection: branch, tag, commit,
SourceSnapshot, update cadence, and auto-sync policy belong to the Git Source /
Run flow. Dashboard handoff must not pin a Store listing's optional `ref` as the
installed ref.

Operators and users can switch Store nodes. Switching the Store changes where
listings are read from and which presentation metadata is used; it does not
change the Capsule execution model, accepted Interface records, or create a
second release/runtime authority.

`variablePresentation`, `installExperience`, `interfaceBlueprints`, lifecycle
actions, output policy, and source-build recipes are top-level DB-owned
InstallConfig fields. They are administered separately from Store listings.
Changing `store` cannot mutate any of them.

Lifecycle actions MUST be pinned into the same reviewed Plan that authorizes the
provider mutation. They MUST NOT be read from repository metadata, source
comments, package scripts, or OpenTofu Output. When a Plan declares
`post_apply`, only terminal `succeeded` permits the Run to succeed, a Capsule
to become `active`, or an Interface blueprint to become Ready. Missing
activator, `pending`, `skipped`, `failed`, and exceptions MUST atomically retain
the provider-applied StateVersion/Output while recording the Run as failed,
the Capsule as `error`, and the Plan as applied. Actual provider apply usage and
billing capture MUST still be recorded. Recovery MUST use a fresh reviewed
plan/apply; the failed Plan MUST NOT be replayed. A declared `pre_destroy` action
MUST terminal-succeed before provider destroy is dispatched. Core MUST use the
generic Run/Capsule status and audit vocabulary and MUST NOT introduce an
app-specific receipt/schema for these actions.

A repository may publish `.well-known/tcs.json` as an optional repo-owned
presentation document for Store indexers. It is not a Takosumi manifest and is
not required for direct Git installs. It can contain display text, icon URL,
and `modulePath`. It must not contain `git`, `source`,
refs/commits, `installConfigId`, variable presentation/defaults,
`installExperience`, output allowlists, release artifacts, domain defaults,
OIDC wiring, lifecycle actions, or Interface blueprints. Public values come
from the module's typed OpenTofu outputs after service-side policy is applied.
Do not use source comments as the metadata schema.

For a Git Source, `source_sync` MUST record a bounded observation of the
repository-root document on the same immutable `SourceSnapshot`, separately
from the selected OpenTofu module archive. A snapshot with no such observation
MAY still be reused by a later source sync. Missing, invalid, or changed
presentation metadata MUST NOT block Store-backed planning or alter the stored
InstallConfig.

The OpenTofu module still owns its variable names. A top-level DB-owned
`installExperience` maps standard install concepts to those module variables:

```json
{
  "projections": [
    { "kind": "service_name", "variable": "project_name" },
    {
      "kind": "public_endpoint",
      "variables": {
        "subdomain": "worker_name",
        "url": "app_url",
        "routePattern": "cloudflare_route_pattern"
      },
      "baseDomain": "app.takos.jp"
    },
    {
      "kind": "initial_secret",
      "variable": "auth_password_hash",
      "secretKind": "password_or_hash",
      "optional": true
    },
    {
      "kind": "oidc_client",
      "variables": {
        "issuerUrl": "takosumi_accounts_issuer_url",
        "clientId": "takosumi_accounts_client_id"
      },
      "callbackPath": "/api/auth/callback/takos"
    },
    {
      "kind": "artifact",
      "variables": {
        "url": "worker_bundle_url",
        "sha256": "worker_bundle_sha256"
      }
    }
  ]
}
```

Rules:

```text
service_name projection:
  friendly resource/service name input.

public_endpoint projection:
  optional public subdomain, URL, route pattern, and operator-managed base
  domain. The dashboard and run engine may derive defaults such as
  <subdomain>.<managed-base-domain> from this mapping, but the module still
  receives plain variables. Takosumi Cloud uses app.takos.jp as its managed base
  domain; other operators can use their own managed base domain under the same
  contract. The repository projection is a portable default; when a managed
  Target is selected, its Provider Connection may advertise
  managedPublicBaseDomain and that value wins for generated URL/route inputs,
  hostname reservations, and OIDC callbacks. This lets staging and production
  use separate namespaces without rewriting Git metadata. Managed-base hostnames are broadly available and protected by
  uniqueness / reserved-name / abuse controls. Arbitrary user-owned custom
  domains are passed through to the selected provider/adapter path; managed
  providers may require ownership verification, certificate provisioning,
  plan/quota, and abuse policy before runtime activation.

initial_secret projection:
  optional first-run password/token input for apps that need one.
  OIDC-backed apps should prefer automatic sign-in and treat this as fallback.

oidc_client projection:
  optional OIDC client variable mapping. Takosumi Accounts can mint client
  metadata into the mapped variables without the app defining Takosumi-specific
  manifest files. It may declare OAuth scopes; `openid` is required, scopes are
  de-duplicated non-empty tokens, and secret-bearing material is not projected.
  The application callback path is explicit and required. Omitted variable
  mappings remain omitted; Takosumi never supplies reserved variable names or a
  product-specific callback default.

artifact projection:
  optional artifact URL / SHA-256 variable mapping. The values stay ordinary
  OpenTofu inputs and are usually produced by the app's Git CI/release flow.
```

There is no universal requirement that every Capsule has a subdomain, password,
or Takosumi-specific env block. Apps that need a public endpoint opt into
`public_endpoint`; apps that need a first-run secret opt into `initial_secret`;
all other knobs stay ordinary variables and are passed to the OpenTofu module
unchanged. Advanced variable presentation such as artifact URL,
artifact digest, container image maps, and app-specific env still map directly
to OpenTofu variables; they are not hidden runner directives.

Install presentation is data-driven. The dashboard must not hide or promote
inputs by hard-coded variable names such as a particular app's artifact URL,
Cloudflare toggle, or route variable. Visibility, secret handling, and guided
setup behavior come from top-level `variablePresentation` plus
`installExperience`; unknown variables remain generic OpenTofu inputs.

`variablePresentation[]` can include `format` (`text`, `url`, `hostname`,
`subdomain`, `password`, `token`, `email`, or `sha256`) for presentation and
validation. The submitted value remains a normal OpenTofu variable.

Do not add `purpose` flags to individual inputs as a pseudo-standard. The
contract is the mapping from standard install concepts to module variables.
Unknown modules remain valid plain OpenTofu Capsules; without
`installExperience`, Takosumi only uses generic variable defaults. Names such as
`worker_name`, `app_url`, and `cloudflare_route_pattern` are ordinary OpenTofu
variables unless the selected InstallConfig explicitly maps them through
the `public_endpoint` projection.

## Performance Model

Takosumi should feel like an app install flow without leaving the
Git/OpenTofu model.

Allowed Takosumi-side speed mechanisms:

```text
SourceSnapshot reuse for identical resolved commits
runner image provider mirror
operator-configured OpenTofu provider plugin cache
serialized tofu init per shared cache path
runner capacity controls
phase timing evidence
user-level progress phases
```

App/container/bundle build optimization belongs in the app repo, CI/release
pipeline, registry, provider, or OpenTofu module inputs.

For hosted/operator materializers, prebuilt app/container artifacts should be
required whenever the activation environment would otherwise build containers or
expensive bundles on operator capacity. A Capsule may explicitly configure
`sourceBuild` for build-on-install. The runner executes argv arrays against the
pinned SourceSnapshot without provider credentials, verifies declared output
paths, then materializes the same Git-hosted OpenTofu module. It never infers
commands from package files, Store listings, or `.well-known/tcs.json`.

## Provider Connections

A ProviderConnection stores credential material or a reference to credential
material for a real OpenTofu/Terraform provider.

```yaml
connections:
  cloudflare-main:
    provider: cloudflare
    auth_type: api_token
    secrets:
      api_token: sec_cloudflare_token
    values:
      account_id: xxxxx

  aws-prod:
    provider: aws
    auth_type: assume_role
    values:
      role_arn: arn:aws:iam::123456789012:role/takosumi
      region: ap-northeast-1

  snowflake-main:
    provider: registry.opentofu.org/snowflake-labs/snowflake
    auth_type: env
    secrets:
      SNOWFLAKE_PASSWORD: sec_snowflake_password
    values:
      SNOWFLAKE_ACCOUNT: example
      SNOWFLAKE_USER: takosumi_runner
```

Secrets are decrypted only for the run sandbox. Runner/runtime-reserved env
names such as `PATH`, `TAKOSUMI_*`, `OPENTOFU_*`, and `TF_*` are rejected for
declared-env recipes.

## Credential Recipes

A CredentialRecipe defines how a provider credential becomes temporary runtime
material.

The reference provider package generates its recipe catalog from
`recipes/providers/*.yaml` into
`providers/credential-recipes.generated.ts`. The runner receives only the
explicit per-Run recipe manifest; `contract/provider-env-rules.ts` contains
generic env-name/source-address rules, not a vendor catalog. Tests keep YAML,
guided provider setup metadata, and runner/vault projection in sync. This
asset is not a Core default. A service composition explicitly installs the
complete catalog, guided setup dispatcher, and runtime driver registry. With
no installed catalog Core lists zero recipes, and the Vault rejects every
provider recipe id as not installed. Arbitrary-env/file behavior is selected
by the installed recipe's `declaredEnv` capability, not by a reserved
`generic-env` recipe id. Hosts may map the reusable
`DECLARED_ENV_CREDENTIAL_RECIPE_DRIVER` to any opaque recipe/auth-mode key;
using the reference id is never required.

A static recipe with no runtime driver is still executable: registration pins
its resolved env/file declaration, `test()` verifies that the sealed material
is structurally complete, and mint passes that material through unchanged. A
mode with `preRun` is different because it promises generated material; it must
have an explicit mint driver. Host compositions filter such modes out of the
installed discovery catalog when no matching driver exists, and a stale stored
row fails closed at test/mint time. The reference composition therefore keeps
implemented AWS AssumeRole but does not advertise unimplemented Google service
account impersonation.

Generic env is a required escape hatch so arbitrary providers can run with
explicit env/file declarations, runner policy, provider plugin policy, and
egress policy.

Credential Recipe discovery is metadata, not admission. The current API lists
the service-installed recipes at `credential-recipes`; it does not expose a
provider catalog. Every valid provider source uses the `opentofu-default`
runner unless the caller explicitly selects an operator-defined capability
profile. Recipe presence is credential-materialization availability only and
never provider execution admission; selection never branches on provider
address.

Provider OAuth helpers are also host-installed. Core's OAuth engine accepts
opaque descriptors and owns state signing, redirect, token exchange, and
callback validation, but it does not discover vendor descriptors from env or
install a reference helper set. The shipped Worker and Bun/Postgres
compositions explicitly contribute the reference provider descriptors.

Provider Connections may carry validated non-secret `providerConfig` and
`moduleInputDefaults` maps. Root generation renders provider configuration and
passes only module-declared defaults. Conflicting defaults fail before runner
dispatch. Provider-specific input names are not encoded in core.

An operator-scoped managed Provider Connection is public/runnable only when its
service-side scope explicitly sets both `managedProvider: true` and a non-empty
opaque `managedProviderProfile`. The receiving platform extension declares the
same exact profile; temporary run credentials use that profile as their token
audience. A missing or different profile fails closed. `providerConfig` remains
opaque OpenTofu provider-block configuration: a `base_url`, provider address,
request hostname, or URL path never makes a connection managed and never
selects a credential issuer. Operators may define any profile tokens they own;
Core ships no managed-provider profile catalog.

The provider plugin cache and filesystem mirror are optimizations and optional
supply-chain controls. Direct registry installation is allowed by default; an
explicit policy may require mirror attestation. Dependency lockfile digest
evidence remains required for provider-bearing Runs.

Provider execution failures retain a stable machine code:

```text
provider_source_invalid
provider_package_unavailable
provider_platform_binary_unavailable
provider_protocol_mismatch
provider_policy_denied
runner_capability_missing
provider_checksum_mismatch
opentofu_init_failed
```

If an industry-standard API or OpenTofu provider already expresses external
infrastructure cleanly, Takosumi uses it through the Stack flow instead of
creating a provider clone. If an operator offers the capacity as a
Takosumi-managed service, its lifecycle is nevertheless modeled as a
provider-neutral Resource Shape. Standard or compatible protocols then become
control-plane translators into that Resource or data-plane access to a Ready
Resource; they do not become lifecycle state owners.

If a mature vendor-neutral provider exists for external infrastructure, prefer
that provider in the Stack flow. For Takosumi-managed capacity, keep the
provider-neutral Resource lifecycle canonical even when a universal client or
protocol exists. `takosumi/takosumi` is only one optional typed client; it does
not define whether the service form exists.

This remains true over time. A new universal client may replace the HCL provider
as the preferred user surface, but its control operations still call the Deploy
API and its data plane still resolves the canonical Ready Resource. This keeps
service state portable without making the Takosumi provider mandatory.

When Takosumi/operator offers durable managed capacity, Takosumi defines it as
a provider-neutral typed Resource Shape even if its public protocol is a
standard one. One-off gaps and external infrastructure remain in
declared-env-capable ProviderConnections and ordinary OpenTofu modules. Add a
Takosumi provider schema only for a repeated managed service form with a clear
schema, validation, planner, adapter path, state/import/drift story, and
capability evidence. A provider resource that is neither a Takosumi-managed
service form nor an operator/admin object has no reason to exist.

Takosumi extension has two layers. Adding a new HCL-facing `takosumi_*`
Resource Shape requires a schema/API/provider release so OpenTofu can keep
typed plan diffs, validation, import, state upgrade, and completion. Adding a
new backend for an existing shape is operator configuration: TargetPool entries
can publish implementation tokens, adapter plugin ids, plugin-local non-secret
options, and interface capability evidence. The Resolver and Adapter decide
whether those tokens are supported by the endpoint.

## Takosumi Provider And API Contract

`takosumi/takosumi` is an optional typed OpenTofu client of the Deploy API. Every public
`takosumi_*` resource is a typed Takosumi Resource Shape or operator/admin
object. It is not a wrapper around existing provider resources, and it must not
call AWS, Cloudflare, Kubernetes, VM, AI, or storage-provider APIs directly.

Provider responsibilities:

```text
HCL schema for Takosumi-owned shapes
local validation
discovery from /.well-known/takosumi and /v1/capabilities
Deploy API preview/apply/delete/status calls
status polling and OpenTofu state output mapping
minimal OpenTofu state mapping
```

Provider non-responsibilities:

```text
vendor API calls
backend selection
credential minting
adapter execution
secret storage
catch-all generic resource handling
edition branching
service-offering or pricing authority
lifecycle state ownership
```

The Resource API is Takosumi-native, but the wire model follows standard
control-plane conventions:

```text
apiVersion / kind / metadata / spec / status
stable ids and names
idempotent create/update semantics
preview before apply
explicit delete
observe/refresh for drift
import for adoption
structured error codes
capability discovery
cursor pagination
```

For a direct adapter plugin, Core supplies the same internal `operationKey`
when an uncertain apply/delete is retried. `apply` must create or update the
provider object by the stable canonical Resource identity, and `delete` must
remove that same object idempotently; replaying one key must never allocate a
second native object. Recovery first performs read-only `observe`: apply uses
read-only refresh for `current`/`drifted` and replays apply only for `missing`,
while delete finalizes read-only for `missing` and replays delete only for
`current`/`drifted`.

Compatibility APIs are clients around the Resource API. Control-plane profiles
translate supported industry-standard requests into typed preview/apply/delete
calls; data-plane profiles resolve an existing Ready Resource and its authorized
Interface/NativeResource evidence. They do not select adapters, call backend
managers directly, own lifecycle rows, or imply full vendor API compatibility.

## Resource Objects

Resource objects use `apiVersion: takosumi.dev/v1alpha1`.

Resource interface requirements and Profile values are capability tokens. They
are not runtime `Interface` objects. The examples in this spec are the built-in
tokens Takosumi ships with; they are not closed enums in the provider binary.
Operators can advertise additional tokens through TargetPool capability
evidence and adapters.

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "EdgeWorker",
  "metadata": {
    "name": "api",
    "space": "prod",
    "project": "myapp",
    "managedBy": "opentofu"
  },
  "spec": {
    "source": {
      "artifactUrl": "https://example.com/releases/api-worker.js",
      "artifactSha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    },
    "compatibilityDate": "2026-06-29",
    "profiles": ["workers_bindings"]
  },
  "status": {
    "phase": "Ready",
    "resolution": {
      "selectedImplementation": "cloudflare_workers",
      "target": "cloudflare-main",
      "locked": true
    },
    "outputs": {
      "worker_name": "api",
      "url": "https://api.example.com"
    }
  }
}
```

`profiles` are endpoint-defined tokens. `workers_bindings` is an example, not
a closed provider-side enum. Validation of support belongs to capability
discovery, TargetPool policy, adapter evidence, and the Resolver.

Resource `connections` are resolved by the control plane immediately before
adapter preview/apply. A referenced resource must exist in the same Space, be
`Ready` at its current generation, and have a ResolutionLock. The adapter
receives the declared permissions/projection together with the referenced
resource kind, selected Target, NativeResource references, and public outputs.
It never receives ProviderConnection or Secret material through this payload.
An adapter must fail closed when it cannot materialize the requested projection
or when a runtime-native binding crosses incompatible Targets. A resource that
is still referenced by another desired Resource cannot be deleted; consumers
must be removed first, matching OpenTofu dependency order. The desired
connection graph must remain acyclic; an apply that would introduce a cycle is
rejected before adapter execution.

These `connections` are adapter-owned infrastructure binding requests. They do
not authorize runtime consumers and must not be normalized into
InterfaceBindings. Conversely, InterfaceBinding never creates or rewrites an
adapter binding.

### Scheduled Resource Observation

The platform worker runs bounded, read-only Resource observation independently
from the Capsule compatibility drift sweep. It is enabled by default when the
host enables at least one Resource Shape kind and can be explicitly disabled by
the operator. It never calls apply or refresh.

Only `Ready` Resources whose `observedGeneration` equals `generation` are
eligible. Candidate order is global across Spaces by the oldest previous
attempt, falling back to `createdAt`, and then stable Resource id. The default
cadence is one hour, with at most eight Resources and four concurrent
observations per cron tick. Operator bounds prevent an accidental configuration
from turning one tick into an unbounded runner fan-out.

Selection uses internal durable lease/cadence columns on the canonical Resource
row in both D1 and Postgres. Those columns are not Resource status, a public API,
or a second lifecycle ledger. A claim has an opaque token and timestamp; only
the exact token can finish it, and an abandoned claim becomes reclaimable after
the lease window. Workers claim only when they have observation capacity, so a
candidate does not consume most of its lease while waiting behind another slow
backend.

The scheduler passes the claimed Resource unchanged to the canonical
`ResourceShapeService.observe` path with a `system` principal. It does not infer
or create a Space-to-Workspace mapping. The service reconstructs the pinned
Target/implementation, records the first-class apply-disabled Resource
`drift_check` Run, and CAS-fences condition updates against concurrent apply or
delete. Success, service-level failure, and backend exceptions all record the
attempt cadence and release the matching lease; process loss relies on stale
lease reclamation. One Resource failure never aborts the other claimed
Resources. The platform exports bounded outcome metrics for operator evidence.

## Composite Products

Composite products are represented by composing typed generic shapes. They do
not get product-specific catch-all Resource Shapes.

Takos is the reference example. Takosumi should be able to describe a Takos
distribution as ordinary Resource Shape objects:

```text
Takos distribution:
  EdgeWorker        -> takos-worker
  SQLDatabase       -> workspace/control database
  KVStore           -> session/cache/state binding
  ObjectBucket      -> files and workspace objects
  Queue             -> agent jobs and product events
  ContainerService  -> takos-agent container
```

The separately installed `takos-git` Capsule has its own generic service
topology and is consumed through Interface/InterfaceBinding.

This means there is no `takosumi_takos` resource and no generic
`takosumi_resource { type, spec }` fallback for Takos. If Takos needs a service
form that the default shapes cannot express, add that missing typed service form
only after the prior-art gate passes. The implementation/backend still remains
an operator decision through TargetPool, Policy, adapter capability evidence,
and ResolutionLock.

## Resolver

Resolver input:

```text
resource shape
interfaces
profiles
connections
triggers
constraints
preferences
space policy
target pool
existing resolution lock
cost model
compliance rules
```

TargetPool entries may include operator-declared implementations. This is how
an operator enables custom adapters without waiting for the `takosumi`
OpenTofu provider binary to know the backend name.

Each entry is a complete, non-secret execution descriptor. Core never infers a
provider source, provider configuration, module template/input, native resource
type, or capability matrix from Target `type`, Resource `shape`, or
`implementation`. A descriptor chooses either `plugin`, or the explicit
`providerSource` + `moduleTemplate` path. A newly created ResolutionLock stores
the complete descriptor and Target snapshots; normal re-apply never migrates.
There is no OSS Core fallback seed when `implementations` is omitted.

```yaml
targets:
  - name: containers-main
    type: kubernetes
    ref: cluster-prod
    credentialRef: conn_k8s_prod
    priority: 80
    implementations:
      - shape: ContainerService
        implementation: custom_container_runtime
        plugin: takosumi-plugin-container-runtime
        options:
          runtime_class: edge
        interfaces:
          oci_container: native
          public_http: shim
          custom.mesh: native
```

Operator-defined shape tokens are accepted by the API/plugin seam. The six
bundled typed provider resources remain a convenience surface, not a global
Resource Shape enum.

`ref` is the target-native reference such as an account id, cluster id, or
fleet id. `credentialRef` is the ProviderConnection / Credential id used by the
opentofu-adapter. They are deliberately separate so account ids, cluster refs,
and credentials cannot be confused.

The Resource Shape parser validates shape-specific structure and rejects empty
or whitespace-bearing AI tokens, but it does not reject unknown AI
interface/profile/provider-preference/routing-strategy tokens. Support is
decided by the resolver, TargetPool capability evidence, policy, credentials,
and the configured adapter.

Resolver output:

```text
selected implementation
selected target
native resource plan
compatibility score
portability score
cost estimate
risk notes
resolution lock
```

Capability levels:

```text
native
shim
emulated
unsupported
```

## Compatibility API Framework

Compatibility APIs are versioned capability profiles. Control-plane profiles
are translation clients of the Deploy API when an operator needs an import or
SDK-compatible facade. Data-plane profiles authorize and resolve canonical
Ready Resources. They are not mandatory when an existing OpenTofu provider or
standard endpoint is already enough.

```text
compat.s3.v1
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
compat.cloudflare.workers.v1
compat.aws.sqs.v1
compat.redis.v1
compat.postgres.v1
```

These are possible capability tokens, not default Takosumi-owned replacements
for Redis, Postgres, SQS, S3, OCI, or other standards. Existing providers and
standard endpoints stay the default unless a Takosumi-managed import,
projection, policy, or metering surface is actually needed.

Do not claim complete AWS API or Cloudflare API compatibility. Specific surfaces are
enabled or disabled by `/v1/capabilities`.

An installed profile declares its authority planes explicitly:

```json
{
  "compatibilityProfiles": [
    {
      "profile": "compat.example.v1",
      "planes": ["control", "data"]
    }
  ]
}
```

The platform advertises the same plane metadata through
`/v1/capabilities.compatibilityProfiles`. `control` dispatch receives only a
Resource Deploy API port constrained to `/v1/resources`; `data` dispatch
receives only a read resolver that rejects Resources that are not fully
observed `Ready` and can return authorized resolved Interface/NativeResource
evidence. The handler contract contains no environment, store, adapter,
backend-manager, or compatibility lifecycle-state port. A `compat.*` capability
without this declaration, a `/compat` raw extension route, or a handler that
does not implement the restricted compatibility entrypoint fails closed and is
not advertised. Core and Accounts route prefixes cannot be delegated to an
extension and always retain dispatch precedence.

Operator/Cloud implementations that expose managed capacity route every
control-plane client through `/v1/resources`. The Deploy API resolves the
provider-neutral shape, applies Policy, writes the ResolutionLock, verifies the
Cloud offering/quote through its injected billing port, and only then dispatches
an adapter/backend manager. The manager decides whether the substrate is
Workers for Platforms, object storage, SQL, KV, queues, workflows, containers,
or another implementation. A Resource adapter never invokes a compatibility
handler as its backend.

Cloud/operator offerings fail closed when a service form is recognized but its
selected manager is not configured. That failure happens before billing
reservation and before the backend API call, so an unsupported
`ContainerService` manager cannot be translated through the Cloudflare Workers
compatibility path or any unrelated route.

For example, ordinary S3/R2/GCS object storage can use existing providers while
`compat.s3.v1` remains disabled. An object-storage Resource Shape or S3
compatibility facade is justified only when an operator needs Takosumi-owned
binding projection, policy, metering, import, or managed placement semantics.

## Discovery

Any Takosumi endpoint should expose product discovery for tooling and the
`takosumi/takosumi` provider.

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

`/capabilities` remains the existing operator-gated route inventory endpoint.
`/v1/capabilities` is the public product capability document.

Interface support is advertised only when `/v1/interfaces`, input resolution,
lifecycle conditions, and `/v1/interfaces/:id/bindings` are implemented. The
capability document reports the supported input sources
(`literal`, `capsule_output`, and `resource_output`); it does not claim support
for arbitrary Interface type/version documents by every consumer. Clients must
not infer support from edition or host identity.

`/v1/capabilities.operator` describes operator operations that are available on
the current host, such as multi-tenant Workspace management, runner pools,
operator-scoped Connections, managed target catalog, DB-backed configuration,
CLI/API/runbook operation, usage showback, and audit evidence. It does not
advertise an operator admin UI. Operator-only changes are applied through
database-backed configuration, CLI/API operations, runbooks, and audit logs.

The official hosted platform serves the `takosumi/takosumi` provider from the
same platform Worker static assets as the dashboard. The mirror base is:

```text
https://app.takosumi.com/opentofu/providers/
```

This is an OpenTofu network mirror, not a separate provider service. The mirror
assets are generated into `dashboard/public/opentofu/providers/` by
`bun run provider:assets` before the dashboard build.

## OIDC And Workload Identity

Standard Takosumi includes the Accounts OIDC issuer. A separate workload
identity API is not yet a current contract: it must be introduced through
generic OIDC principal, Resource Credential/Policy, or Credential Recipe seams,
not vendor-specific federation routes. Operator/Cloud may add enterprise SSO,
SAML, SCIM, advanced session policy, and tenant isolation through those seams.

Provider execution credentials use Provider Connection + Credential Recipe.
Recipe `authModes` keys and `preRun.type` drivers are open operator/provider
tokens; Core does not publish a closed `static_secret` / `oidc_federation` /
`agent_local` / `managed` ownership taxonomy. Helpers may implement those flows,
but only an explicitly selected recipe controls Run-local env/file/action
materialization.

## State

Takosumi keeps three state layers separate:

```text
OpenTofu state
Takosumi resource state
Native resource state
```

OpenTofu provider state for `takosumi_*` resources should hold Takosumi resource
ids and outputs, not secret material or raw native provider internals.

For the Stack flow, a successful apply captures `tofu output -json` as the
current Capsule Output. An Interface may explicitly resolve a non-sensitive
value from that captured generation, but Output does not become a runtime
registry or state store.

## Billing And Usage Events

Core records usage events reported by enabled shapes and adapters. Queue, DB,
VM, and other service-family events exist only when an operator or Cloud
adapter enables those service forms; their presence here is not a statement
that OSS core owns those resources by default.

```text
EdgeWorker request count
EdgeWorker execution time
Object storage bytes, when an operator enables a managed storage surface
Object storage request count, when an operator enables a managed storage surface
Queue messages
DB storage
DB compute
VM hours
Build minutes
Egress
```

Operator/Cloud turns usage into meters, rating, invoices, payment, commercial
quota, and support tooling.

Hosted Resource Shape API and compatibility API calls are attributed to a
Workspace, not to a required Capsule record. A request may carry a Capsule id
when it exists, but direct `takosumi` provider and Cloudflare-compatible import
calls can be metered with only an authenticated actor and verified Workspace.
Cloud-only payment enforcement authorizes the
normalized dispatch plan after selected-manager availability is confirmed and
before forwarding to the backend. OSS core remains limited to disabled/showback
usage recording unless an operator injects an enforcement port.

Usage amounts are USD-denominated. New code writes `usdMicros` plus required
`ratingStatus`; legacy `credits` are derived only for older storage and clients.
Core records runner duration as the provider-neutral `runner_minute`
measurement. Core owns no price: the host-injected `ShowbackRater` returns the
amount and `rated` evidence. Without that port, showback persists zero /
`unrated`; `disabled` persists no automatic measurement. An `unrated` event
must always have zero `usdMicros`, while `rated` zero remains distinguishable.

An enforcing Cloud host extends preview/apply through a commercial port without
adding Cloud fields to the Resource shape. Its required semantics are:

```text
preview:
  resolve a versioned ServiceOffering
  rate against a versioned PriceCatalog
  return DeploymentQuote bound to desired-state + resolution digests

apply:
  require quote id + quote digest
  verify offering/price/currency/expiry/digests
  reserve before adapter/backend work
  capture only after canonical Resource success
  release after failure or cancellation

period close:
  reconcile captured reservations + rated UsageEvents - releases/refunds
  against payment-provider invoice lines
```

Unknown offerings, unpriced billable SKUs, expired/mismatched quotes, and
unconfigured managers fail before reservation or backend work. Explicit free
service uses a rated-zero SKU. Reservation/capture/release and invoice lines are
idempotent and retain account, Workspace/Resource, offering/SKU/price version,
quote/usage ids, quantity/unit, currency, tax treatment, period, and audit
evidence. `DeploymentQuote` is a Cloud commercial record around a Resource
operation; it is not an OSS `Deployment` lifecycle ledger.

## Security

OSS and Cloud share these invariants:

```text
secrets are encrypted at rest
provider credentials are injected only into the run sandbox
logs are redacted before persistence
runs use a temporary workspace
temporary credential files are removed after the run
provider plugin cache stores provider binaries only
state is isolated per Workspace/Capsule/Resource
apply approval is supported
destroy protection is supported
audit log is required
Interface documents and resolved inputs contain no secret values
InterfaceBinding credentials are short-lived or invocation-materialized
```

Operator/Cloud deployments additionally require tenant isolation, runner pool
isolation, quota, network egress policy, admin audit, and usage metering.

## MVP Order

1. Discovery and capability documents: `/.well-known/takosumi`,
   `/v1/capabilities`.
2. OpenTofu Stack controller: Git, runner, state, logs, approval, credentials.
3. ProviderConnection / CredentialRecipe / generic env / OIDC federation.
4. Interface storage/API, generic input resolution, provenance, lifecycle, and
   InterfaceBinding authorization.
5. Move first-party runtime consumers to Interface reads and invocation-time
   Principal OAuth credentials; remove legacy Output convention and
   Workspace-wide Output reconcile paths.
6. Resource object schema, Resource API preview/apply/status, ResolutionLock.
7. EdgeWorker / ObjectBucket / KVStore / Queue / SQLDatabase /
   ContainerService planner and provider schemas.
8. TargetPool implementation plugin fields.
9. Add scoped compatibility profiles only where existing providers are not
   enough for import, binding, policy, or metering.
10. Add future shapes one service form at a time.
11. Kubernetes / VM / agent-local credentials where they are needed as targets.
12. Operator/Cloud commercial operation and official managed targets.
