# Takosumi API

The Takosumi API exposes the Git-based OpenTofu control plane and the Resource
Shape API.

It is not a combined clone of Cloudflare, AWS, Kubernetes, or other vendor APIs.
External infrastructure keeps its existing providers and standard APIs. A
service offered as Takosumi-managed capacity is defined as a provider-neutral
Resource Shape and has one lifecycle authority: the `/v1/resources` Deploy API.

## Rule

```text
External resource has a standard API / OpenTofu provider:
  use that surface through the plain Stack flow.

Takosumi/operator offers managed capacity:
  define a provider-neutral Resource Shape and manage it through the Deploy API.

One-off gap:
  use generic-env ProviderConnection and an ordinary OpenTofu module.
```

`takosumi/takosumi` is an optional typed client for this API. The provider does not call
vendor APIs directly and does not choose backends. It sends preview / apply /
delete / status requests to the Deploy API, and the Takosumi endpoint runs the
Resolver, Adapter, TargetPool, and Policy logic. The provider does not own the
service catalog, prices, or lifecycle state.

## Discovery

Every Takosumi endpoint exposes discovery.

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

The provider, CLI, and dashboard branch on capabilities, not edition names.

Example:

```json
{
  "apiVersions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "resourceShapes": true,
    "opentofuRunner": true,
    "oidc": true,
    "compatS3": true,
    "compatCloudflareWorkers": false,
    "billing": false
  },
  "endpoints": {
    "api": "https://takosumi.example.com",
    "oidcIssuer": "https://takosumi.example.com"
  }
}
```

## Object Model

Resource Shape objects use a Kubernetes-style shape.

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "EdgeWorker",
  "metadata": {
    "name": "api",
    "space": "prod",
    "managedBy": "opentofu",
    "labels": {
      "app": "example"
    }
  },
  "spec": {
    "name": "api",
    "source": {
      "artifactPath": "dist/worker.js"
    },
    "profiles": ["workers_bindings"]
  },
  "status": {
    "phase": "Ready",
    "observedGeneration": 3,
    "conditions": [
      {
        "type": "Ready",
        "status": "True"
      }
    ]
  }
}
```

`spec` is desired state. `status` is observed state. Secret material is never
stored in `spec`, `status`, OpenTofu state, logs, or audit records.

## Authentication

API clients use a session cookie or bearer token depending on the endpoint.

```http
Authorization: Bearer <token>
```

Each Takosumi endpoint publishes the session / bearer token model enabled by
its operator through capabilities. Takosumi Cloud API keys are Takosumi
Accounts personal access tokens. Endpoints with their own standard signing
model, such as S3-compatible storage, use that protocol's signature instead.

## OpenTofu Stack API

The Stack API runs plain OpenTofu / Terraform modules from Git. Existing
providers run as-is in this flow. The stock composition uses the provider-neutral
`opentofu-default` execution path; an operator can explicitly select a different
capability profile without using provider names as routing authority. Known
providers only receive Credential Recipe, guided setup, and cache/mirror
conveniences. Recipe presence is not an admission tier.

Operator-installed setup recipes are discovered through:

```http
GET /api/v1/credential-recipes
```

A provider without a recipe can run without a Connection or use an explicit
generic env/file ProviderConnection according to that provider's own
documentation. Non-secret `providerConfig` and `moduleInputDefaults` may carry
endpoint, region, or ordinary module defaults; credential-shaped fields are
rejected and secret values must use ProviderConnection values/files.

Representative operations:

```http
POST   /v1/workspaces
GET    /v1/workspaces/{workspaceId}

POST   /v1/projects
GET    /v1/projects/{projectId}

POST   /v1/sources
GET    /v1/sources
GET    /v1/sources/{sourceId}
PATCH  /v1/sources/{sourceId}
POST   /v1/sources/{sourceId}/sync
GET    /v1/sources/{sourceId}/snapshots

POST   /v1/capsules
GET    /v1/capsules/{capsuleId}
PATCH  /v1/capsules/{capsuleId}

POST   /v1/provider-connections
GET    /v1/provider-connections
GET    /v1/provider-connections/{connectionId}
DELETE /v1/provider-connections/{connectionId}

POST   /v1/runs
GET    /v1/runs/{runId}
GET    /v1/runs/{runId}/logs
POST   /v1/runs/{runId}/approve
POST   /v1/runs/{runId}/cancel

GET    /v1/capsules/{capsuleId}/state-versions
GET    /v1/capsules/{capsuleId}/outputs
GET    /v1/audit-events
```

A Run is one ledger entry with a `plan`, `apply`, `destroy`, `refresh`, or
`output` operation. Plan / Apply / Destroy are not separate ledgers.

A Capsule that builds from a Git checkout can declare an optional `sourceBuild`
at creation time. This is not Store metadata; it is a Capsule setting that the
user explicitly approves.

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

Each command is an argv array, not a shell string. `workingDirectory` and
`outputs` are limited to relative paths inside the Git checkout, and no
provider credential is passed to the build phase. When `sourceBuild` is not
set, the OpenTofu module resolves its artifact as usual from a release
artifact URL/digest, a provider, or a data source.

When repository `public_endpoint` metadata projects a managed hostname, Capsule
creation may choose its allocation mode. The default is `scoped`:

```json
{
  "managedPublicHostname": { "mode": "vanity" }
}
```

`scoped` produces
`<workspace-handle>-<label>.<managed-base-domain>` without consuming a vanity
slot. `vanity` keeps `<label>.<managed-base-domain>` and consumes one finite
slot owned by the Workspace's immutable owner account. Both modes reserve the
hostname first-come-first-served.

Managed hostname reservations and vanity slots belong to the Capsule lifetime.
A successful Capsule destroy releases them; deleting an individual route does
not. User-owned custom domains use a separate verified-domain lifecycle rather
than this mode. In Takosumi Cloud that verification and certificate lifecycle is
not implemented, so the feature is Planned and requests against Cloud-managed
routes fail closed. This does not prevent an ordinary OpenTofu URL/route variable
from being passed to a BYOC provider. The setting selects control-plane
allocation policy; it does not bypass or replace the OpenTofu variables.

A Run stores:

```text
source snapshot
OpenTofu version
provider lock digest
ProviderBinding
injected env metadata, not values
plan/apply result
state version
outputs
logs
actor
audit evidence
```

`Source.defaultRef` accepts a branch, tag, or commit. When `Source.autoSync` is
enabled, the scheduler or source webhook syncs the Git ref and stores the
resolved commit as a `SourceSnapshot`. If an active Capsule tracks that Source
and its currently applied SourceSnapshot differs from the newly resolved commit,
the Capsule becomes `stale`. From there, the existing Workspace update /
RunGroup flow creates a reviewable plan, and apply follows the normal Run
approval path. Takosumi does not choose or fetch application artifacts outside
the OpenTofu module.

An explicit update review first syncs the Source, then pins the immutable
`SourceSnapshot` produced by that request into compatibility checking and the
plan. A client must not accept an older pre-existing snapshot as the result of a
new sync request. The session API supports an explicit intent:

```http
POST /api/v1/sources/{sourceId}/sync
Content-Type: application/json

{ "intent": "manual_plan" }
```

`observe` (the default) is for webhook and scheduled observation and may
evaluate Capsule auto-update when the Capsule opted in. `manual_plan` prepares
a user-reviewed plan and does not independently start another auto-update
plan/apply. Continue only after the returned SourceSyncRun is `succeeded` and
its `sourceSnapshotId` is present in the Source snapshot list.

## Deploy API / Resource Shape API

`/v1/resources` is the Deploy API for provider-neutral managed Resources. It is
the sole lifecycle authority for preview/apply/observe/refresh/import/delete and
for canonical Resource, ResolutionLock, NativeResource, Run, status, Output,
and audit evidence. The typed provider, CLI, dashboard, Kubernetes CRDs, and
control-plane compatibility handlers are clients of this API.

On a multi-tenant platform, the session / personal access token / service
token / OAuth token paths require the request's `space` to match the caller's
verified Workspace id. The platform worker cross-checks the query, top-level
body, and `metadata.space` before converting the request into an internal
actor, and rejects a mismatched Space with `403`. Core never creates an
implicit Space-to-Workspace mapping. Only an operator path holding a direct
deploy-control bearer, or a future explicitly verified mapping, can manage a
different Space.

Control-plane compatibility handlers translate supported requests into typed
Resource requests and call this Deploy API. They do not own lifecycle rows,
resolver decisions, or backend selection. Data-plane profiles resolve a Ready
canonical Resource and authorized Interface/NativeResource evidence before
accessing a backend.

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
POST   /v1/resources/{kind}/{name}/import
GET    /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources/{kind}/{name}/events?space={spaceId}&limit={1..100}&cursor={opaque}
POST   /v1/resources/{kind}/{name}/observe?space={spaceId}
POST   /v1/resources/{kind}/{name}/refresh?space={spaceId}
DELETE /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources?space={spaceId}&limit={1..100}&cursor={opaque}
```

OSS preview does not require pricing. On a Cloud endpoint with the commercial
billing extension, billable preview returns a `DeploymentQuote` from a
versioned `ServiceOffering` and `PriceCatalog`, and apply requires
`quoteId + quoteDigest`. The quote binds the Resource spec digest, resolution
fingerprint, offering/catalog versions, SKU line items, currency, estimated
total micros, and issue/expiry times. Cloud reserves before backend work, captures
after canonical Resource success, releases on failure/cancellation, and
reconciles rated UsageEvents with payment-provider invoice lines. The wire field
is advertised by a versioned commercial extension contract; Cloud-only fields
are not added to the portable OSS Resource object.

Resource listing uses keyset pagination over `createdAt` and Resource id. Every
non-final page returns `nextCursor`; clients must treat it as opaque and echo it
as the next `cursor`. The default and maximum page size are both 100.

`observe` is a read-only drift check against the Target and implementation
already pinned by the durable `ResolutionLock`. OpenTofu-backed Resources create
a non-applyable `drift_check` Run; plugin-backed Resources invoke the adapter's
`observe` action. Takosumi CAS-fences the resulting `Drifted`, `Reconciling`, and
`Degraded` conditions so a stale observation cannot overwrite a concurrent
apply or delete. Detecting drift does not auto-apply or select another Target;
the current revision and endpoint remain pinned.

The platform worker's scheduled observer calls the same `observe` path. On a
host with enabled Resource Shapes it is on by default and selects only `Ready`
Resources at their current generation, globally oldest-first across Spaces,
through a bounded durable lease. Defaults are a one-hour cadence, eight
Resources per tick, and four concurrent observations. This is internal
scheduler state, not another public Resource ledger or an auto-apply path. The
operator can tune the cadence, batch, concurrency, lease, or disable the sweep.

`refresh` runs OpenTofu `plan -refresh-only` followed by the reviewed saved-plan
apply, or invokes the selected plugin's `refresh` action, against the same pinned
Target and implementation. It updates only Resource-owned state and public
Outputs, never native provider resources, and resolves affected Interface
revisions only after success. A CAS claim serializes refresh with normal apply
and delete; failure leaves the Resource `Failed` and its Interfaces `Unknown`.
Refresh-only drift changes are not rated as native resource materialization;
runner usage remains separately recorded.

`import` adopts an existing backend resource into the Takosumi Resource ledger.
The request body contains the normal Resource object plus a top-level
`nativeId`. The selected Target implementation must declare either a plugin or
an explicit `moduleImportAddress` (`resource_type.name` inside the child
module). An OpenTofu-backed import adds a configuration-driven `import` block to
the generated root and plans it as an ordinary `Run`. Takosumi applies the saved
plan only when plan JSON proves exactly one `change.importing` entry and no
create, update, or delete actions, then publishes Resource-owned state, Outputs,
and NativeResource evidence. Plugin imports are likewise limited to read-only
inventory lookup. A failed unpublished import record can be removed without
calling backend delete. `nativeId` is a provider-native identifier, not a
credential, and must never carry a secret.

`/events` returns a newest-first keyset page of Resource history. It is a
non-secret `space + resourceId` projection of the shared Activity / Run audit
ledger, not another Resource-state or Run authority, and remains readable after
the Resource record is deleted. Metadata is limited to phases, generations,
identifiers, and counts; credentials, raw errors, specs, state, and Output
values are never exposed.

The Resource Shape API is typed. Takosumi does not expose a catch-all
`takosumi_resource { type, spec }` as the normal interface.

Current v1alpha1 public shapes:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
SQLDatabase
ContainerService
VectorIndex
DurableWorkflow
StatefulActorNamespace
Schedule
```

Composite products such as Takos are still expressed as this set of generic
shapes, not as a dedicated `takosumi_takos` resource. For example, the
`takos-worker` is an `EdgeWorker`, the workspace/control database is a
`SQLDatabase`, file and workspace objects use `ObjectBucket`, agent jobs and
events use `Queue`, and `takos-agent` is a `ContainerService`. The separately
installed `takos-git` Capsule has its own generic service topology. If Takos
later needs a service form these shapes cannot express, add
that missing typed shape only after the same prior-art gate passes.

Even when `ObjectBucket` exists, the data plane remains S3-compatible. AI
Gateway is not a provider resource; apps consume it as an OpenAI-compatible
endpoint through env/secret projection. `spec.storageClass` is the
provider-neutral default for newly written objects. Its exact values are
`standard` and `infrequent_access`, and omission is normalized to `standard`.
`infrequent_access` resolves only when the TargetPool advertises
`storage_class_infrequent_access`; unsupported placement fails before backend
calls. The selector does not implicitly change objects written earlier. The
Takosumi provider exposes the same input as `storage_class`.

## Target / Credential / Policy API

Backends are resolved through TargetPool, Policy, capability evidence, and
ResolutionLock. Normal `takosumi_*` HCL does not hard-code backend placement.
This is an operator/advanced API. The default deploy UX exposes the service
form, required inputs, price, preview, and apply without requiring users to
understand TargetPool, Policy, or Adapter configuration.
`/v1/capabilities.adapters` may return operator-defined adapter tokens as
additional boolean keys alongside the known keys (`opentofu`, `aws`,
`cloudflare`, `kubernetes`, `vm`, and `takosumi_native`). Those extension keys
add implementations for existing typed shapes; they do not create new
`takosumi_*` HCL resource types at runtime. New shapes still require a
schema/API/provider release.

```http
PUT    /v1/target-pools/{name}
GET    /v1/target-pools/{name}?space={spaceId}
GET    /v1/target-pools?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/target-pools/{name}?space={spaceId}

PUT    /v1/space-policies/{name}
GET    /v1/space-policies/{name}?space={spaceId}
GET    /v1/space-policies?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/space-policies/{name}?space={spaceId}
```

An operator bootstrapping a default pool can add `If-None-Match: *` to the
same PUT for an atomic create-only request. Creation returns `201`; an existing
Space/name returns `412 target_pool_exists` without replacing its capability
evidence. PUT without that header keeps the explicit create/update behavior.

Targets are currently complete operator-authored capability entries in
`TargetPool.spec.targets[]`, not a separate unwired `/v1/targets` resource.
Resource Shape SpacePolicy records are created, read, listed, and deleted
through the same Space-scoped endpoint family.

Provider execution credentials are owned by the OpenTofu Stack flow's Provider
Connections and Credential Recipes. Recipe `authModes` keys and `preRun.type` values are open tokens
published by an operator/provider; Core has no fixed `static`, `oidc`, or cloud
vendor taxonomy. Secret values are write-only and are materialized into env/files
only for a Run according to the selected recipe.

## OIDC / Workload Identity

Takosumi Accounts exposes the standard issuer surface for registered OIDC
clients.

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
GET  /oauth/authorize
POST /oauth/token
```

A standalone ServiceAccount/workload-federation API is not part of the current
public surface. Core does not expose fixed AWS, GCP, or Kubernetes federation
routes or credential kinds. A future workload-identity surface must use generic
OIDC principals, Resource Credential/Policy, or explicit Credential Recipe
pre-run actions and ship only with matching implementation and discovery.
Operator/Cloud may add Enterprise SSO, SCIM, and commercial audit export through
that generic seam.

A Capsule-projected public OIDC client can declare required scopes through
`installExperience.oidc_client.scopes`; `openid` is mandatory. Accounts access
tokens carrying `capsules:read` or `capsules:write` are bound to one Workspace,
and canonical Capsule-ledger reads and Interface invocations validate both scope and Workspace. Clients
allowed to request `offline_access` may receive refresh tokens. Consumers must
encrypt token material in their secret store and never place it in OpenTofu
state or Outputs.

## Compatibility API

Compatibility APIs preserve scoped standard protocol/API facades.
Control-plane profiles are translation clients of the Deploy API; data-plane
profiles are authorized access surfaces for canonical Ready Resources. They are
not independent resource ledgers or backends.

```text
compat.s3.v1
  S3-compatible Object Storage data/control path

compat.oci.v1
  Artifact / ContainerImage lifecycle

compat.cloudevents.v1
  Queue / EventHandler event ingress

compat.kubernetes.crd.v1
  Kubernetes northbound API

compat.cloudflare.workers.v1
  scoped Workers-compatible import/deploy path
```

These are not full AWS API compatibility or full Cloudflare API compatibility claims. Scope is
published through capabilities and a compatibility matrix.

Control-plane compatibility, typed `takosumi_*` resources, dashboard, and CLI
use different public protocols but converge on the same Resource desired state
and Deploy API lifecycle. Data-plane profiles never create a Resource
implicitly; they resolve one that is already Ready. Operations outside a scoped
profile fail closed and are documented in the compatibility matrix instead of
pretending full vendor compatibility.

Compatibility route or script-subdomain writes that create a managed hostname
must include source Workspace and source Capsule context and use the same OSS
hostname reservation authority as Capsule Runs. Cloud-extension KV or Durable
Object routing and activation records are not the source of truth for hostname
ownership. A route-level DELETE removes only that state and does not release a
reservation owned by the Capsule lifetime.

Takosumi Cloud-specific endpoint examples live in
[Cloud endpoints](https://app.takosumi.com/docs/en/endpoints).

## Error Shape

Failures return structured errors.

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "compat.cloudflare.workers.v1 is not enabled for this endpoint",
    "requestId": "req_123"
  }
}
```

Secret values, temporary credentials, and internal adapter credentials are never
included in errors.

## Versioning

The current API version is `takosumi.dev/v1alpha1`.

```text
v1alpha1:
  breaking changes are allowed. Update docs and conformance together.

v1beta1:
  core shape is fixed. Upgrade and conversion guidance required.

v1:
  backward compatibility maintained. No field removals.
```

OSS / Operator / Cloud differences are represented by capabilities, not API
version.
