# Takosumi API

The Takosumi API exposes the Git-based OpenTofu control plane, provider
connections, Runs, and Interface / InterfaceBinding authorization. Takoform is
an ordinary OpenTofu provider. External hosts own any additional API or
instance lifecycle beyond this control plane.

It is not a combined clone of Cloudflare, AWS, Kubernetes, or other vendor APIs.
External infrastructure keeps its existing providers and standard APIs.

## Rule

```text
External resource has a standard API / OpenTofu provider:
  use that surface through the plain Stack flow.

An external Host offers a Form instance:
  use that Host's own API and lifecycle contract.

One-off gap:
  use generic-env ProviderConnection and an ordinary OpenTofu module.
```

Takosumi does not ship a first-party Terraform/OpenTofu provider. Use Takoform
as an ordinary provider, and use this API, CLI, or dashboard for the supported
Git/OpenTofu control-plane operations. External providers continue to run
through plain Stack execution. Takosumi owns that Stack's Run, state, Output,
and audit records; the provider and its state still own provider-side objects.

## Discovery

Every Takosumi endpoint exposes discovery.

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

The CLI, dashboard, and portable clients branch on capabilities, not edition names.

Example:

```json
{
  "product": "takosumi",
  "name": "Takosumi",
  "auth": {
    "oidc": true,
    "password": false
  },
  "apiBaseUrl": "https://takosumi.example.com/api/v1",
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "opentofu_runner": true,
    "oidc": true,
    "workload_identity": true,
    "compat_framework": true,
    "compatibility_profiles": [],
    "interfaces": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api",
    "capabilities": "https://takosumi.example.com/v1/capabilities",
    "oidc_issuer": "https://takosumi.example.com"
  }
}
```

Field names are case-sensitive. `endpoints.api` is `<origin>/api`, while
`apiBaseUrl` is `<origin>/api/v1`.

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

Every Stack route is under `/api/v1`. The `/v1` routes are the separate
Resource, Interface, Form, and capability control surface. Mixing the two
prefixes produces a 404 even when authentication is valid.

The authoritative session-route inventory is
`accounts/service/src/control-route-inventory.ts`; it currently contains 80
public route descriptors. Representative operations from that inventory are:

```http
POST  /api/v1/workspaces
GET   /api/v1/workspaces/{workspaceId}

POST  /api/v1/workspaces/{workspaceId}/projects
GET   /api/v1/projects/{projectId}

POST  /api/v1/sources
GET   /api/v1/sources
GET   /api/v1/sources/{sourceId}
PATCH /api/v1/sources/{sourceId}
POST  /api/v1/sources/{sourceId}/sync
GET   /api/v1/sources/{sourceId}/snapshots

POST  /api/v1/workspaces/{workspaceId}/capsules
GET   /api/v1/capsules/{capsuleId}
PATCH /api/v1/capsules/{capsuleId}
POST  /api/v1/capsules/{capsuleId}/plan

GET  /api/v1/connections
POST /api/v1/connections
POST /api/v1/connections/{connectionId}/test
POST /api/v1/connections/{connectionId}/revoke

GET  /api/v1/runs/{runId}
GET  /api/v1/runs/{runId}/logs
POST /api/v1/runs/{runId}/approve
POST /api/v1/runs/{runId}/apply
POST /api/v1/runs/{runId}/cancel

GET /api/v1/capsules/{capsuleId}/state-versions
GET /api/v1/capsules/{capsuleId}/outputs
GET /api/v1/workspaces/{workspaceId}/activity
```

Interactive clients such as the Dashboard read Workspaces through bounded
pages. `limit` is capped at 100, `cursor` is the opaque token returned by the
previous page, and `order` is either `created_asc` or `updated_desc`. Passing
the current Workspace as `selectedWorkspaceId` pins that authorized Workspace
to the first response even when it falls outside the ordinary page;
`pinnedWorkspaceId` identifies the extra row. The ordinary page still contains
at most `limit` rows and the full response at most `limit + 1`.

```http
GET /api/v1/workspaces?limit=50&order=updated_desc&selectedWorkspaceId=ws_current
GET /api/v1/workspaces?limit=50&order=updated_desc&cursor=<opaque>
```

The response contains `workspaces`, `returned`, `limit`, `truncated`, and
optional `nextCursor` / `pinnedWorkspaceId`. Only management operations that
need an exact count request `includeTotal=true`; ordinary interactive reads
omit it so D1/Postgres complete with a `limit + 1` probe and no extra
`count(*)`. The queryless `GET /api/v1/workspaces` is also a bounded page in
`created_asc` order with a maximum of 100 rows. Clients that genuinely need all
authorized Workspaces must follow `nextCursor`.

Account-wide migration and discovery clients use the separate read-only
projection:

```http
GET /api/v1/views/workspaces.v1?limit=100&cursor=<opaque>
```

This route derives its subject only from the authenticated account session and
always requests active membership rows in `created_asc` order with archived
Workspaces included and an exact `total` counted before cursor filtering. The
default and hard maximum `limit` are 100; the only accepted query keys are
`limit` and `cursor`. A Workspace-scoped session, PAT, or OAuth credential is
rejected with 403, and the route performs no personal-Workspace bootstrap or
other writes. The response `kind` is
`takosumi.account-workspace-inventory@v1` and contains `workspaces`, `total`,
`returned`, `limit`, `truncated`, and an optional opaque `nextCursor`.

The Dashboard reads launcher Interfaces authorized with `ui.open` for the
exact Principal derived from the current account session through one
account-session API request. Optional `capsuleId` is only an owner filter and
does not influence the authorization principal. The response contains only
authorized Interfaces and never exposes InterfaceBinding records.

```http
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?limit=100
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?capsuleId={capsuleId}&limit=50
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?cursor=<opaque>&limit=100
```

The response contains `interfaces` and an optional `nextCursor`. The read
defaults to 100 rows and clamps larger limits to 100. Authorization is resolved
with a bounded current-Principal Binding query; listing never reconciles or
writes Interface lifecycle state. Individual invocation and token issuance
still revalidate the exact Interface and Binding immediately before use.

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

Reservation only runs for a Capsule config that carries the `public_endpoint`
projection, so a per-install patch (`PATCH /api/v1/capsule-configs/:id`) cannot
remove it — dropping it would leave the endpoint variables in place while
skipping reservation and its ownership check.

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

## Generic Offering catalog, availability, and selection API

An OSS operator can publish an exact noncommercial Offering catalog. A principal
can query availability and resolve an exact selection:

```http
POST /v1/offering-catalogs
GET  /v1/offering-catalogs?limit={n}&cursor={opaque}
GET  /v1/offering-catalogs/{catalogId}/versions/{catalogVersion}
POST /v1/offering-availability/query
POST /v1/offering-selections/resolve
```

Each Offering pins an exact `catalog id/version + offering id/version`, an open
subject `type + ref + version + digest`, exact requirement references, audience,
profile, region, maturity, and active state. The API returns that exact choice
as an `OfferingSelection`. It pins the subject and requirements, resolver id,
resolution fingerprint, and resolution time.
There is no `latest` fallback. Unknown subject types, absent resolvers, inactive
catalogs/Offerings, audience mismatches, and stale requirements fail closed. A
resolver rechecks the exact subject and requirement evidence before returning a
selection.

OSS Offering and selection state contains no price, SKU, payment, manager,
credentials, raw capacity, SLA, or support. A hosted service can attach those
details through a separate extension after Core has returned an exact
selection. It does not replace the OSS catalog or selection engine.


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
`installExperience.oidc_client.scopes`; `openid` is mandatory. A client id is
owned by its Capsule: an install whose `clientIdVariable` names another
Capsule's client id fails with `failed_precondition`
(`oidc_client_id_already_bound`). Accounts access
tokens carrying `capsules:read` or `capsules:write` are bound to one Workspace,
and canonical Capsule-ledger reads and Interface invocations validate both scope and Workspace. Clients
allowed to request `offline_access` may receive refresh tokens. Consumers must
encrypt token material in their secret store and never place it in OpenTofu
state or Outputs.

## Compatibility API

Compatibility APIs preserve scoped standard protocol/API facades. Control-plane
profiles are translation clients of the supported control-plane APIs, while
data-plane profiles are authorized Interface access surfaces. They are not
independent ledgers or backends.

```text
compat.s3.v1
  S3-compatible Object Storage data/control path

compat.oci.v1
  Artifact / ContainerImage lifecycle

compat.cloudevents.v1
  Queue / EventHandler event ingress

compat.kubernetes.crd.v1
  Kubernetes northbound API
```

These are not complete provider API compatibility claims. Scope is
published through capabilities and a compatibility matrix.

Compatibility handlers, dashboard, and CLI use different public protocols but
converge on the same supported control-plane lifecycle. Operations outside a
scoped profile fail closed and are documented in the compatibility matrix
instead of pretending full vendor compatibility.

The Cloudflare-specific import/deploy compatibility profile is retired and is
not part of the supported v1 API or capability surface. Customer-owned
Cloudflare resources use a normal ProviderConnection and plain Stack flow.

Compatibility profiles do not create hostnames implicitly. Runtime routes use a
canonical `http.route` Interface plus InterfaceBinding, while hostname
ownership belongs to the OSS reservation authority or the Operator/Cloud
VerifiedDomain lifecycle. Routing caches and backend state are never hostname
ownership authority.

Takosumi Cloud-specific endpoint examples live in
[Cloud endpoints](https://app.takosumi.com/docs/en/endpoints).

## Error Shape

Failures return structured errors.

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "compat.example.v1 is not enabled for this endpoint",
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
