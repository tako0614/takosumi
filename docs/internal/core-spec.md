# Takosumi Core Spec

Last updated: 2026-07-03

This document describes the OSS core specification. Product direction is fixed
by [Takosumi Final Plan](./final-plan.md).

## Definition

Takosumi OSS is a Git-based OpenTofu control plane with resource-shape
resolution.

It supports two flows:

```text
Flow A:
  plain OpenTofu/Terraform stack execution from Git

Flow B:
  Takosumi Resource Shape API resolved through TargetPool, Policy, and adapters
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
AuditEvent ledger
Runner protocol
policy and approval hooks
Resource Shape API
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

### Resource Shape Flow

| Concept        | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| Space          | Resource API namespace and policy scope                       |
| Environment    | Deployment environment within a Space/Project                 |
| Stack          | Git-backed OpenTofu stack or resource-shape bundle            |
| Resource       | Kubernetes-like desired/observed resource object              |
| ResourceShape  | Resource form such as EdgeWorker, ObjectBucket, or Queue      |
| Interface      | External protocol/API such as web_fetch, s3_api, or queue     |
| Profile        | Ecosystem compatibility surface such as workers_bindings      |
| Implementation | Concrete backend such as cloudflare_workers or cloudflare_r2  |
| Target         | Southbound account/cluster/fleet/runtime endpoint             |
| TargetPool     | Candidate targets used by the resolver                        |
| Credential     | Target or workload credential configuration                   |
| Policy         | Constraints, approvals, lifecycle, and resolution rules       |
| Adapter        | Code that previews/applies/observes a selected implementation |
| ResolutionLock | Persisted selected implementation + target                    |
| NativeResource | Concrete backend resource reference                           |
| Condition      | Ready / Reconciling / Drifted / Degraded / Blocked evidence   |

`Space` in this model is the Resource API namespace and policy scope. The public
model uses Workspace / Project / Capsule / Run / StateVersion / Output /
Resource Shape / Target / Adapter.

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
plans in dependency order. Takosumi still does not apply Git changes silently;
apply remains a reviewed Run unless an explicit operator policy adds a separate
auto-apply gate.

Takosumi does not decide app artifact semantics. If a module needs an image
reference, release tag, object key, URL, or digest, the module declares a normal
variable or provider/data-source logic.

## Install Store Experience Contract

The install Store is discovery and presentation only. A Store node announces
that a Git repository/path exists and can present friendly setup fields, icons,
and descriptions. It does not own release selection: branch, tag, commit,
SourceSnapshot, update cadence, and auto-sync policy belong to the Git Source /
Run flow. Dashboard handoff must not pin a Store listing's optional `ref` as the
installed ref.

Operators and users can switch Store nodes. Switching the Store changes where
listings are read from and which presentation metadata is used; it does not
change the Capsule execution model or create a second release authority.

Store entries may expose an optional `installExperience` object. This is a
dashboard UX contract, not execution authority.

A repository may publish `.well-known/tcs.json` as an optional repo-owned
presentation document for Store indexers. It is not a Takosumi manifest and is
not required for direct Git installs. It can contain display text, icon URL,
`modulePath`, setup inputs, `installExperience`, and output allowlist hints. It
must not contain `git`, `source`, `ref`, `commit`, `resolvedCommit`, or
`installConfigId`; those belong to the Store listing service and the Git
Source / Run flow. Do not use source comments as the metadata schema.

The OpenTofu module still owns its variable names. `installExperience` maps
standard install concepts to those module variables:

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
  contract. Managed-base hostnames are broadly available and protected by
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
  manifest files.

artifact projection:
  optional artifact URL / SHA-256 variable mapping. The values stay ordinary
  OpenTofu inputs and are usually produced by the app's Git CI/release flow.
```

There is no universal requirement that every Capsule has a subdomain, password,
or Takosumi-specific env block. Apps that need a public endpoint opt into
`public_endpoint`; apps that need a first-run secret opt into `initial_secret`;
all other knobs stay ordinary store inputs or generic variables and are passed
to the OpenTofu module unchanged. Advanced store inputs such as artifact URL,
artifact digest, container image maps, and app-specific env still map directly
to OpenTofu variables; they are not hidden runner directives.

Install presentation is data-driven. The dashboard must not hide or promote
inputs by hard-coded variable names such as a particular app's artifact URL,
Cloudflare toggle, or route variable. Visibility, secret handling, and guided
setup behavior come from `store.inputs[]` plus `installExperience`; unknown
variables remain generic OpenTofu inputs.

`store.inputs[]` can include `format` (`text`, `url`, `hostname`,
`subdomain`, `password`, `token`, `email`, or `sha256`) for presentation and
validation. The submitted value remains a normal OpenTofu variable.

Do not add `purpose` flags to individual inputs as a pseudo-standard. The
contract is the mapping from standard install concepts to module variables.
Unknown modules remain valid plain OpenTofu Capsules; without
`installExperience`, Takosumi only uses generic variable defaults. Names such as
`worker_name`, `app_url`, and `cloudflare_route_pattern` are ordinary OpenTofu
variables unless the store explicitly maps them through
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

Built-in recipes live under `recipes/providers/*.yaml`. The dependency-free
runner projection is `contract/provider-env-rules.ts`; tests keep YAML,
provider runtime registry, and runner/vault projection in sync.

Generic env is a required escape hatch so arbitrary providers can run with
explicit env/file declarations, runner policy, provider plugin policy, and
egress policy.

If an industry-standard protocol, API, or OpenTofu provider already expresses
the service cleanly, Takosumi should use that standard surface through the
Stack flow or a scoped compatibility profile instead of creating a
Takosumi-owned clone. S3-compatible object storage, OCI registry, Kubernetes
CRDs, CloudEvents, OpenAI-compatible APIs, and scoped Cloudflare
Workers-compatible import/deploy paths are examples of standard-conscious
surfaces.

If a mature vendor-neutral provider exists outside Takosumi, prefer that
provider. Takosumi can still manage ProviderConnections, env/file injection,
runs, state, outputs, policy, usage, and compatibility gates around it without
forcing the user onto `takosumi/takosumi`. The Takosumi provider exists only
where a durable service form lacks an adequate vendor-neutral provider/protocol
and needs Takosumi-owned schema, planner, adapter, state, import, drift, policy,
metering, or managed-target placement.

This remains true over time. A `takosumi_*` resource is not a lock-in claim. If
Takosumi filled a missing universal surface and the ecosystem later gets an
adequate vendor-neutral provider, protocol, or compatibility surface, new
designs should prefer that universal path. The Takosumi shape may stay for
state continuity, import, migration, or managed-target semantics, but it should
not be treated as mandatory.

If a durable service form has no adequate standard surface, Takosumi should
define it as a typed Resource Shape. One-off gaps still stay in generic-env
ProviderConnections and ordinary OpenTofu modules. Add a Takosumi provider
resource only when the missing surface is a repeated service form with a clear
schema, validation, planner, adapter path, state/import/drift story, and
capability evidence. A provider resource that is neither a Takosumi-owned
service form nor a standard compatibility surface has no reason to exist.

Takosumi extension has two layers. Adding a new HCL-facing `takosumi_*`
Resource Shape requires a schema/API/provider release so OpenTofu can keep
typed plan diffs, validation, import, state upgrade, and completion. Adding a
new backend for an existing shape is operator configuration: TargetPool entries
can publish implementation tokens, adapter plugin ids, plugin-local non-secret
options, and interface capability evidence. The Resolver and Adapter decide
whether those tokens are supported by the endpoint.

## Takosumi Provider And API Contract

`takosumi/takosumi` is a Takosumi-native OpenTofu provider. Every public
`takosumi_*` resource is a typed Takosumi Resource Shape or operator/admin
object. It is not a wrapper around existing provider resources, and it must not
call AWS, Cloudflare, Kubernetes, VM, AI, or storage-provider APIs directly.

Provider responsibilities:

```text
HCL schema for Takosumi-owned shapes
local validation
discovery from /.well-known/takosumi and /v1/capabilities
Resource API preview/apply/delete/status calls
status polling and output projection
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

Compatibility APIs are different from the Resource API. They exist specifically
to preserve industry-standard surfaces when Takosumi provides the backend or
import path: S3-compatible object storage, OCI registry, CloudEvents,
Kubernetes CRDs, OpenAI-compatible AI gateway endpoints, or scoped Cloudflare
Workers-compatible import/deploy paths. Those facades enter Takosumi
capabilities; they do not become the canonical internal model and they do not
imply full vendor API compatibility.

## Resource Objects

Resource objects use `apiVersion: takosumi.dev/v1alpha1`.

Interface and Profile values are capability tokens. The examples in this spec
are the built-in tokens Takosumi ships with; they are not closed enums in the
provider binary. Operators can advertise additional tokens through TargetPool
capability evidence and adapters.

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
  ContainerService  -> takos-git and takos-agent containers
```

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
target capabilities
cost model
compliance rules
```

TargetPool entries may include operator-declared implementations. This is how
an operator enables custom adapters without waiting for the `takosumi`
OpenTofu provider binary to know the backend name.

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

Compatibility APIs are versioned capability profiles. They are entrypoints into
the Resource API when an operator actually needs an import path, data-plane
proxy, or SDK-compatible facade. They are not mandatory when an existing
OpenTofu provider or standard endpoint is already enough.

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

Operator/Cloud implementations that expose managed capacity should normalize
compatibility API calls, Resource Shape adapter calls, dashboard actions,
data-plane facades, Cloudflare-compatible Worker route writes/deletes, and
billable service endpoints such as AI Gateway into the same managed-operation
request shape before calling a backend manager. The public API surface decides
how the user enters Takosumi; the selected manager decides whether the backend is
Workers for Platforms, R2, D1, KV, Queues, Workflows, Containers, AI Gateway
upstream routing, or another operator-provided implementation.
The shared boundary produces a managed-operation descriptor and dispatch plan
before usage authorization, so manager availability is checked before a request
can spend credits or call a backend API.

Cloud/operator descriptors should fail closed when a service form is recognized
but its selected manager is not configured. That failure happens before usage
precharge and before the backend API call, so an unsupported `ContainerService`
manager cannot be accidentally translated through the Cloudflare Workers
compatibility path or any other unrelated route.

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

Standard Takosumi includes an OIDC issuer and workload identity primitives.
Operator/Cloud may add enterprise SSO, SAML, SCIM, advanced session policy, and
tenant isolation.

Credential modes:

```text
static_secret
oidc_federation
agent_local
managed
```

## State

Takosumi keeps three state layers separate:

```text
OpenTofu state
Takosumi resource state
Native resource state
```

OpenTofu provider state for `takosumi_*` resources should hold Takosumi resource
ids and outputs, not secret material or raw native provider internals.

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
Workspace, not to a required app-installation record. A request may carry a
Capsule / installation id when it exists, but direct `takosumi` provider and
Cloudflare-compatible import calls can be metered with only an authenticated
actor and verified Workspace. Cloud-only payment enforcement authorizes the
normalized dispatch plan after selected-manager availability is confirmed and
before forwarding to the backend. OSS core remains limited to disabled/showback
usage recording unless an operator injects an enforcement port.

Usage amounts are USD-denominated. New code writes `usdMicros`; legacy
`credits` are derived only for older storage and clients. Runner duration is
recorded as `runner_minute` with a fine-grained USD micros amount computed from
actual elapsed minutes and the core runner-minute showback price, so a short
OpenTofu run is not rounded to a whole-dollar compatibility credit.

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
```

Operator/Cloud deployments additionally require tenant isolation, runner pool
isolation, quota, network egress policy, admin audit, and usage metering.

## MVP Order

1. Discovery and capability documents: `/.well-known/takosumi`,
   `/v1/capabilities`.
2. OpenTofu Stack controller: Git, runner, state, logs, approval, credentials.
3. ProviderConnection / CredentialRecipe / generic env / OIDC federation.
4. Resource object schema, Resource API preview/apply/status, ResolutionLock.
5. EdgeWorker / ObjectBucket / KVStore / Queue / SQLDatabase /
   ContainerService planner and provider schemas.
6. TargetPool implementation plugin fields.
7. Add scoped compatibility profiles only where existing providers are not
   enough for import, binding, policy, or metering.
8. Add future shapes one service form at a time.
9. Kubernetes / VM / agent-local credentials where they are needed as targets.
10. Operator/Cloud commercial operation and official managed targets.
