# Takosumi API

The Takosumi API exposes the Git-based OpenTofu control plane and the Resource
Shape API.

It is not a combined clone of Cloudflare, AWS, Kubernetes, or other vendor APIs.
When an industry-standard surface exists, Takosumi keeps that surface. When a
durable service form has no adequate standard surface, Takosumi defines a typed
shape.

## Rule

```text
Standard API / protocol / OpenTofu provider exists:
  use that surface.

No standard surface exists, and the service form is repeated:
  define a Takosumi Resource Shape.

One-off gap:
  use generic-env ProviderConnection and an ordinary OpenTofu module.
```

`takosumi/takosumi` is a thin client for this API. The provider does not call
vendor APIs directly and does not choose backends. It sends preview / apply /
delete / status requests to the Resource API, and the Takosumi endpoint runs the
Resolver, Adapter, TargetPool, and Policy logic.

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
    "labels": {
      "app": "example"
    }
  },
  "spec": {
    "artifact": {
      "path": "dist/worker.js"
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
providers run as-is in this flow.

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

## Resource Shape API

The Resource Shape API is the typed Resource object API used by `takosumi_*`
provider resources, CLI, dashboard, Kubernetes CRDs, and similar Takosumi-native
clients.

Compatibility APIs are separate first-class surfaces. When a standard protocol
or existing tool is the best fit, the compatibility API remains the public
surface. A handler may normalize Resource, NativeResource, usage, or audit
evidence internally, but that is bookkeeping; it does not make the compatibility
API subordinate to the `takosumi` provider or the Resource Shape API.

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
GET    /v1/resources/{kind}/{name}
DELETE /v1/resources/{kind}/{name}
GET    /v1/resources
GET    /v1/resources/{id}/events
POST   /v1/resources/{id}/refresh
POST   /v1/resources/{id}/import
```

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
```

Composite products such as Takos are still expressed as this set of generic
shapes, not as a dedicated `takosumi_takos` resource. For example, the
`takos-worker` is an `EdgeWorker`, the workspace/control database is a
`SQLDatabase`, file and workspace objects use `ObjectBucket`, agent jobs and
events use `Queue`, and `takos-git` / `takos-agent` are `ContainerService`
resources. If Takos later needs a service form these shapes cannot express, add
that missing typed shape only after the same prior-art gate passes.

Even when `ObjectBucket` exists, the data plane remains S3-compatible. AI
Gateway is not a provider resource; apps consume it as an OpenAI-compatible
endpoint through env/secret projection.

## Target / Credential / Policy API

Backends are resolved through TargetPool, Policy, capability evidence, and
ResolutionLock. Normal `takosumi_*` HCL does not hard-code backend placement.
`/v1/capabilities.adapters` may return operator-defined adapter tokens as
additional boolean keys alongside the known keys (`opentofu`, `aws`,
`cloudflare`, `kubernetes`, `vm`, and `takosumi_native`). Those extension keys
add implementations for existing typed shapes; they do not create new
`takosumi_*` HCL resource types at runtime. New shapes still require a
schema/API/provider release.

```http
POST /v1/targets
GET  /v1/targets
PUT  /v1/targets/{targetId}

POST /v1/target-pools
GET  /v1/target-pools
PUT  /v1/target-pools/{targetPoolId}

POST /v1/credentials
GET  /v1/credentials
POST /v1/credentials/{credentialId}/rotate

POST /v1/policies
GET  /v1/policies
```

Credentials can use `static`, `oidc`, `agent`, or `managed` modes. Secret
values are write-only.

## OIDC / Workload Identity

Takosumi can expose an OIDC issuer for service accounts, runners, agents, and
external cloud federation.

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
POST /oauth/token

POST /v1/identity/service-accounts
POST /v1/identity/tokens
POST /v1/identity/federation/aws
POST /v1/identity/federation/gcp
POST /v1/identity/federation/kubernetes
```

Operator / Cloud can add Enterprise SSO, SCIM, and commercial audit export, but
the workload identity contract belongs to standard Takosumi.

A Capsule-projected public OIDC client can declare required scopes through
`installExperience.oidc_client.scopes`; `openid` is mandatory. Accounts access
tokens carrying `capsules:read` or `capsules:write` are bound to one Workspace,
and the Capsule projection API validates both scope and Workspace. Clients
allowed to request `offline_access` may receive refresh tokens. Consumers must
encrypt token material in their secret store and never place it in OpenTofu
state or Outputs.

## Compatibility API

Compatibility APIs preserve standard protocol/API facades and are independent
Takosumi-managed feature surfaces. They are peer entrypoints alongside the
plain Stack flow and typed Resource Shapes, not subordinate routes into the
`takosumi` provider.

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

Compatibility APIs, typed `takosumi_*` Resource Shapes, S3-compatible APIs,
OpenAI-compatible APIs, Kubernetes CRDs, and CloudEvents-compatible APIs are
parallel surfaces. Selection depends on capability, fit with existing tools,
and which service forms the operator enables; no surface is the universal
source of truth for the others.
The `takosumi` provider exists to define service forms that lack an adequate
vendor-independent provider or protocol. Operations outside a scoped
compatibility profile fail closed and are documented in the compatibility
matrix instead of pretending full vendor compatibility. If a sufficient
universal provider, protocol, or standard surface appears later, prefer that
surface for new work. Keep the Takosumi shape only where it still adds import
continuity, migration, managed-target placement, policy, or metering value.

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
