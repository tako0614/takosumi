# Takosumi Core Spec

Last updated: 2026-06-29

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
source ref. `Source.autoSync` may prepare a newer immutable source snapshot; it
does not apply changes by itself.

Takosumi does not decide app artifact semantics. If a module needs an image
reference, release tag, object key, URL, or digest, the module declares a normal
variable or provider/data-source logic.

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

If a durable service form has no adequate standard surface, Takosumi should
define it as a typed Resource Shape. One-off gaps still stay in generic-env
ProviderConnections and ordinary OpenTofu modules. Add a Takosumi provider
resource only when the missing surface is a repeated service form with a clear
schema, validation, planner, adapter path, state/import/drift story, and
capability evidence. A provider resource that is neither a Takosumi-owned
service form nor a standard compatibility surface has no reason to exist.

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
      "artifactPath": "/work/dist/worker.js"
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
      "worker_name": "api"
    }
  }
}
```

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

Do not claim complete AWS or Cloudflare compatibility. Specific surfaces are
enabled or disabled by `/v1/capabilities`.

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
