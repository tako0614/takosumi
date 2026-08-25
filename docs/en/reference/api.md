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
The Cloudflare-specific import/deploy compatibility profile is retired and is
not part of this API.

## Discovery

Every Takosumi endpoint exposes discovery.

```http
GET /.well-known/takosumi
GET /api/v1/capabilities
GET /openapi.json
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
    "interfaces": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api/v1",
    "capabilities": "https://takosumi.example.com/api/v1/capabilities",
    "openapi": "https://takosumi.example.com/openapi.json",
    "oidc_issuer": "https://takosumi.example.com"
  }
}
```

Field names are case-sensitive. `endpoints.api` is `<origin>/api/v1`, while
`apiBaseUrl` is `<origin>/api/v1`.

## Authentication

API clients use a session cookie or bearer token depending on the endpoint.

```http
Authorization: Bearer <token>
```

Each Takosumi endpoint publishes the session / bearer token model enabled by
its operator through capabilities. Takosumi API keys are Takosumi
Accounts personal access tokens. Endpoints with their own standard signing
model, such as S3-compatible storage, use that protocol's signature instead.

### Accounts personal access tokens

The public Accounts PAT surface is listed below. Every response, including
authentication and input errors, carries `Cache-Control: no-store` and
`Pragma: no-cache`.

| Method | Path                                  | Authentication                     | Purpose                               |
| ------ | ------------------------------------- | ---------------------------------- | ------------------------------------- |
| GET    | `/api/v1/account/tokens`                  | account session                    | interactive list                       |
| GET    | `/api/v1/account/tokens/scopes`           | account session                    | current self-service scope catalog     |
| POST   | `/api/v1/account/tokens`                  | account session                    | create a PAT                           |
| POST   | `/api/v1/account/tokens/{tokenId}/revoke` | account session                    | revoke a PAT                           |
| GET    | `/api/v1/account/tokens/inventory.v1`     | account session                    | complete versioned metadata inventory  |
| GET    | `/api/v1/account/tokens/current`          | `Authorization: Bearer <PAT>` only | current authority of the presented PAT |

The scope catalog marks only core `read` / `write` and allowlisted extension
scopes explicitly declared by the same owning route through
`selfServicePatScopes` as self-service. Takosumi hosted AI `ai.models.read`, `ai.chat`,
and `ai.embeddings`, plus `resources:read`, require a Workspace binding.
Accounts never infers self-service authority from request scopes and never
exposes `admin` or an undeclared scope for self-service issuance.

`GET /api/v1/account/tokens/inventory.v1` does not replace the existing Dashboard
list. Its default `limit` is 50 and its hard maximum is 100. Rows are ordered
by `created_at`, then `token_id`, ascending. The response kind is
`takosumi.account-pat-inventory@v1`; its closed envelope contains only `kind`,
`tokens`, `total`, `returned`, `limit`, `truncated`, and `next_cursor`. `total`
is the complete pre-cursor count of subject-owned active and revoked PATs. One
storage statement reads that count, the exact cursor anchor, and the
`limit + 1` page. Each token contains only `token_id`, `subject`, `name`,
`prefix`, `scopes`, `workspace_id`, `created_at`, `expires_at`, `revoked_at`,
and `last_used_at`; optional metadata is `null`, and the secret is never
returned. The cursor is opaque. A malformed cursor or one whose exact
subject-owned anchor is gone returns 400 `invalid_request`.

`GET /api/v1/account/tokens/current` ignores ambient cookies,
`x-takosumi-account-session`, and query/body tokens. Accounts resolves the
presented opaque bearer across the account-session, OAuth access-token, and PAT
stores before selecting a kind. A collision, non-PAT, revoked PAT, or expired
PAT returns 401 `invalid_token`. Success kind is
`takosumi.account-pat-authority@v1`, with only `kind`, `token_id`, `subject`,
`scopes`, `workspace_id`, `expires_at`, and `workspace_role`. Generic PATs have
null Workspace fields. Workspace-bound PATs use one dedicated exact membership
SELECT: unavailable verification returns 503 `verification_unavailable`, while
an inactive or mismatched membership returns 403
`workspace_membership_inactive`. This read does not update `last_used_at`,
audit, sessions, the Control schema, or Workspace / Project / TargetPool state.

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

Every public Takosumi JSON route is under `/api/v1`. The old `/v1` namespace is
not a public API and known retired paths fail closed with 404. OIDC/OAuth,
well-known, health/metrics, and operator-only `/internal/v1` remain separate
protocol and authority surfaces.

The authoritative session-route inventory is
`accounts/service/src/control-route-inventory.ts`; it currently contains 86
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
GET   /api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/deployment-profiles

POST  /api/v1/workspaces/{workspaceId}/capsules
GET   /api/v1/capsules/{capsuleId}
PATCH /api/v1/capsules/{capsuleId}
POST  /api/v1/capsules/{capsuleId}/plan

POST /api/v1/workspaces/{workspaceId}/install-plans
GET  /api/v1/install-plans/{installPlanId}
POST /api/v1/install-plans/{installPlanId}/reconcile

POST /api/v1/capsules/{capsuleId}/revision-plans
GET  /api/v1/revision-plans/{revisionPlanId}
POST /api/v1/revision-plans/{revisionPlanId}/reconcile

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

Creating a Git install plan requires `Idempotency-Key`. Replaying the same
normalized request in the same Workspace and actor scope returns the same
record; reusing the key for different input returns 409. The coordinator stores
only bounded references to the Source, immutable SourceSnapshot, DB-owned
InstallConfig, Capsule, and canonical Plan Run. It rejects variable values,
credentials, tokens, and Output values. Reconciliation stops at a reviewable
Plan Run; approval and apply remain exclusively on the Run API, with no
install-plan apply route.

Creating a Git revision plan also requires `Idempotency-Key` and accepts only
`{ "ref": "<git-ref>" }`. Creation returns 201, replaying the same normalized
request under the same key returns 200, and reusing the key for different input
returns 409. It fences the existing Capsule, Source,
InstallConfig, and state generation; it does not patch the Source default ref or
path. Reconciliation creates deterministic SourceSyncRun, SourceSnapshot,
compatibility, and Plan Run evidence so a lost acknowledgement adopts the same
canonical mutation. An unconfirmed mutation returns 202 with
`nextAction: "reconcile"`; a reviewable Run returns `nextAction: "review_run"`
and stops. State rollback remains the
separate `POST /api/v1/state-versions/{stateVersionId}/rollback-plan` flow.

Creating or reconciling a revision plan does not change what the Capsule
tracks. Only a successful apply that advances `currentStateVersionId` adopts
the Plan Run's SourceSnapshot as the Capsule's tracking authority.
`GET /api/v1/capsules/{capsuleId}` exposes that non-secret derived value as
`adoptedSourceRevision: { sourceSnapshotId, ref, path, resolvedCommit }`; it is
absent before the first successful apply.

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

Public hostnames, DNS, and application endpoints belong to the ordinary
OpenTofu module and provider in the Git checkout. Takosumi neither synthesizes
nor reserves Capsule hostnames; `public_endpoint` metadata only projects an
applied Output into the UI.

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
enabled, the scheduler or source webhook syncs both the Source default address
and each ref/path lane adopted by a current Capsule StateVersion. The resolved
commit is stored as a `SourceSnapshot`. An active Capsule becomes `stale` only
when the new snapshot is on its adopted ref/path lane and differs from its
currently applied snapshot. Another lane never stales it or rewrites the Source
default. Ordinary update plans also select the latest snapshot on the adopted
lane. From there, the existing Workspace update /
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
Operator/hosted service may add Enterprise SSO, SCIM, and commercial audit export through
that generic seam.

Takosumi does not auto-register an Accounts OIDC client from a Capsule or
InstallConfig. Operators/compositions register OIDC clients explicitly.
Already-registered Capsule clients continue through the migration drain, but
each use revalidates the current Capsule, InstallConfig, Workspace membership,
and scopes; invalid terminal bindings are revoked best-effort. Accounts tokens
and Interface invocations continue to validate both scope and Workspace.
Consumers must encrypt token material in their secret store and never place it
in OpenTofu state or Outputs.

The optional `workspace_id` selector on `GET /oauth/authorize` lets a Principal
with multiple Workspaces choose the token's authority scope. Accounts
revalidates live membership immediately before issuing the authorization code
and, for a Capsule-owned client, also verifies the Capsule's owning Workspace.
Duplicate, empty, control-character, oversized, or unauthorized values are
rejected. The resulting access token records only the verified Workspace and
role.

A static composition OIDC client may likewise request a Workspace-bound token by
supplying `workspace_id`. For this Capsule-free client, the ID token and UserInfo
responses emit `takosumi.workspace_id` and the current `takosumi.role`, and omit
`capsule_id`. UserInfo emits exactly one `workspace_memberships` entry:
`[workspace_id]`. Capsule-owned clients continue to include their verified
`capsule_id` in `takosumi`. If membership is revoked or suspended, UserInfo and
refresh are rejected fail-closed.

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

OSS / Operator / hosted-service differences are represented by capabilities, not API
version.
