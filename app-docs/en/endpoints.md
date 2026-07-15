# Takosumi Cloud endpoints

This page documents the endpoint families exposed by `app.takosumi.com` for
Takosumi Cloud. These are treated separately from the portable Takosumi OSS /
Takosumi for Operator APIs.

Use [Takosumi Cloud](./index.md) and
[Takosumi Cloud resources](./resources.md) for the official Cloud description.
This page is the detailed reference for endpoints, usage, API keys, and
compatibility routes.

The app screen should show operational facts that people need day to day: API
keys, connection health, this month's usage, balance, and current resource
counts. The full endpoint contract, scope, and examples live in this document.

## App screen and docs split

`app.takosumi.com/cloud` is a screen focused on managing API keys and resources.

- creating, listing, and revoking API keys
- Cloud resources (KV / Object Storage / Database / Workers): list, copy IDs,
  and delete
- AI Gateway base URL, connection health, and default model
- OpenTofu import endpoint base URL and current virtual account
- Object Storage endpoint base URL and S3-compatible bucket configuration health

Usage and billing live on the Billing screen (`app.takosumi.com/billing`), not
on the Cloud screen:

- this month's usage, Cloud resource usage, and available balance
- usage history (usage event records)

Deleting a resource submits a delete action through the shared Cloud
managed-resource operation boundary. Resources created through a
Cloudflare-shaped import path can also be deleted through that compatible
endpoint's DELETE. Deletion requires a `write`-scoped session and only takes
effect when the Cloud managed resource has been created. Unsupported endpoint
families answer 501 and fail closed. DELETE cleanup is not a billable fallback
operation, so a source Workspace whose owning account has run out of credit can
still destroy or remove already-created managed resources. The app screen does
not carry the full specification — provider compatibility scope, OpenTofu
provider examples, usage event contracts, and secret-handling rules belong in
docs.

## Boundary

Takosumi OSS has the Git-based OpenTofu control plane, Resource Shape API,
Compatibility API framework, and Adapter system.

Only the Takosumi for Operator / Cloud operation layer has:

- AI Gateway
- Takosumi Cloud resources
- official hosted Cloudflare-compatible import endpoint backend
- official S3-compatible Object Storage endpoint backend
- official managed target / native resource backends
- official usage, quota, billing, and support controls

Official `app.takosumi.com` serves Cloud endpoint families on the same hosted
platform origin. AI Gateway, the Cloudflare-compatible import endpoint, the
S3-compatible Object Storage endpoint, Cloud usage, and Cloud Edge Runtime are
served by Takosumi Cloud managed backends. Managed-backend internals, secrets,
and operator-only records are not public contracts; they belong in operator
runbooks.
All managed endpoint families normalize into the same Cloud managed-operation
boundary before a backend API is called. Cloudflare-compatible paths,
`takosumi_*` Resource Shape calls, S3-compatible data-plane requests, AI Gateway
requests, runtime dispatch, and Dashboard actions are peer entrypoints. They
are not fallback layers for each other. The platform resolves the public service
form, selected manager, and usage meter first; unsupported paths return 501, and
recognized paths whose manager is unavailable return 501 before usage is
charged or any provider backend is touched.

## Catalog

Use this route to inspect enabled Cloud endpoints. The dashboard reads it with
the account session cookie. Automation can read it with a service token that has
the appropriate read scope.

```http
GET /__takosumi/cloud/extensions
```

Example:

```json
{
  "kind": "takosumi.platform-cloud-extensions@v1",
  "generatedAt": "2026-06-26T00:00:00.000Z",
  "serviceUrl": "https://app.takosumi.com",
  "extensions": [
    {
      "id": "ai",
      "kind": "ai_gateway",
      "protocol": "openai-compatible",
      "basePath": "/gateway/ai/v1",
      "configured": true,
      "capabilities": ["openai.chat_completions", "openai.embeddings"],
      "smokeChecks": ["models", "chat"],
      "requiredScopes": ["ai.chat", "ai.embeddings"]
    },
    {
      "id": "cloudflare",
      "kind": "provider_compat",
      "provider": "cloudflare",
      "protocol": "cloudflare-v4",
      "basePath": "/compat/cloudflare/client/v4",
      "configured": true,
      "capabilities": ["workers", "kv", "r2", "d1", "queues", "workflows"],
      "requiredScopes": ["read", "write"]
    },
    {
      "id": "s3",
      "kind": "data_compat",
      "provider": "object-storage",
      "protocol": "s3-compatible",
      "basePath": "/compat/s3/v1",
      "configured": true,
      "capabilities": ["compat.s3.v1"],
      "authMode": "handler",
      "smokeChecks": ["status", "put-get-delete"]
    },
    {
      "id": "usage",
      "kind": "usage_ingest",
      "basePath": "/cloud/usage",
      "configured": true,
      "requiredScopes": ["cloud.usage.write"]
    }
  ],
  "summary": {
    "total": 4,
    "configured": 4,
    "missing": 0
  }
}
```

An extension with `configured: false` may appear in the screen, but runtime
calls fail closed.
This catalog lists only public endpoints and capabilities.
`authMode: "handler"` is the catalog value for endpoint families that verify a
standard protocol signature, such as S3 SigV4. In that mode, the request is
authorized by the protocol signature rather than a platform session/PAT, and
spoofable Takosumi context headers and cookies are stripped.
Takosumi Cloud public HTTP traffic for `*.app.takos.jp` and
`*.app-staging.takos.jp` is dispatched to the Cloud runtime through the same
hosted-origin hostname dispatch registry.

## API key / owner billing context

The Resource Shape API used by the `takosumi` provider (`/v1/resources`,
`/v1/target-pools`, and `/v1/space-policies`) and the Cloudflare-compatible
import endpoint (`/compat/cloudflare/client/v4`) are not anonymous endpoints. A
request must authenticate with an account session, personal access token, or
service token, and the source Workspace plus owning user's billing account must
be verified. A Workers route verifies a profile-owned Ready `EdgeWorker` in the
same Workspace and the calling Principal before mutating its canonical
Interface / InterfaceBinding. It does not create a Capsule hostname.

Sessions and personal access tokens may select the source Workspace with
`x-takosumi-cloud-billing-workspace-id`. The platform verifies that the token
can read that Workspace in the accounts plane, resolves the owning user's
billing account / credit balance, then forwards to the target Cloud endpoint
family or Resource Shape API. For OpenTofu providers such as the Cloudflare
provider that do not conveniently attach arbitrary headers, create the personal
access token with `workspace_id`. The platform then uses the token
introspection `takosumi.space_id` as the default source Workspace, so provider
configuration only needs `api_token` and `base_url`. Service tokens may only
use the Workspace encoded in token metadata.

When OpenTofu uses a Takosumi Cloud managed compatibility target, store that
Workspace-bound token in a generic-env ProviderConnection and inject it into the
runner as `CLOUDFLARE_API_TOKEN`. For a plain OpenTofu stack importing an
existing Cloudflare provider manifest, set the provider `base_url` to the
Takosumi Cloud compatibility endpoint. In Resource Shape TargetPools,
`providerBaseUrl` is only accepted for operator-allowlisted URLs on
operator-installed `plugin` implementations.
The generated provider block contains only `base_url`; the secret does not land
in HCL, plan output, or state. Targets that deploy to a real Cloudflare account
continue to use the user's normal Cloudflare ProviderConnection.

For billable Resource writes, `/v1/resources` creates an immutable quote from a
versioned offering and PriceCatalog, then reserves it during reviewed apply
before calling a backend. A compatibility control request first translates to
an `EdgeWorker` or `ObjectBucket` request and follows that same lifecycle. A
missing Workspace, token/Workspace mismatch, expired or mismatched quote, or
insufficient balance fails closed before reservation or backend access. Worker
route CRUD is an Interface mutation on a Ready Resource, not Resource creation
or hostname reservation.

## S3-compatible Object Storage endpoint

When `/v1/capabilities` advertises the `compat.s3.v1` data plane, the
S3-compatible endpoint lets existing S3 SDKs and S3-compatible OpenTofu
providers consume a Takosumi Cloud `ObjectBucket`. It is not full AWS API
compatibility and it is not a second bucket lifecycle API.

```http
GET  /compat/s3/v1/__takosumi/status
GET  /compat/s3/v1
HEAD /compat/s3/v1/{bucket}
GET  /compat/s3/v1/{bucket}?list-type=2
GET  /compat/s3/v1/{bucket}/{key}
HEAD /compat/s3/v1/{bucket}/{key}
PUT  /compat/s3/v1/{bucket}/{key}
DELETE /compat/s3/v1/{bucket}/{key}
```

Normal Cloud API keys (Takosumi Accounts personal access tokens) are not S3 SDK
credentials. The S3-compatible endpoint verifies AWS SigV4 access key / secret
access key credentials. Each access key maps to an explicit Workspace Principal
and optional bucket allowlist. A bucket descriptor points to one canonical
`ObjectBucket`, resolved `Interface`, and matching `NativeResource`. Every data
request fails closed unless the Resource is `Ready` and the Principal has the
required Interface permission.

Create, update, import, and delete the bucket through the normal
`/v1/resources` preview/review/apply lifecycle. Bucket-level S3 mutation methods
return `405 MethodNotAllowed`; they never create a backend bucket or a second
lifecycle record.

`GET /compat/s3/v1/__takosumi/status` is readable without SigV4 and reports
operational configuration health. The dashboard uses it to show configured
bucket counts.

Supported data operations are rated through the central Cloud usage ledger from
the immutable price evidence captured for that exact `ObjectBucket`. If price,
capture, invoice, or payment authority is missing, the request fails closed
before storage is touched. The usage event preserves source Workspace and
canonical Resource attribution; the compatibility handler neither owns prices
nor keeps a parallel billing ledger.

## API keys

Dashboard-created Cloud API keys are Takosumi Accounts personal access tokens.
The secret value is returned only once at creation time.

```http
GET  /v1/account/tokens
POST /v1/account/tokens
POST /v1/account/tokens/{tokenId}/revoke
```

Normal Cloud endpoint keys should use:

```json
{
  "scopes": ["read", "write"],
  "workspace_id": "space_xxx"
}
```

`read` is enough for `GET` / `HEAD` / `OPTIONS`. `write` is required for
mutating routes such as creating, updating, or deleting compatibility
resources. `admin` is not needed for normal Cloud endpoint use.

List responses must not expose the secret value again. Safe metadata for UI
display and revoke actions includes `id`, `name`, `prefix`, `scopes`,
`created_at`, `expires_at`, `revoked_at`, and `last_used_at`. `subject` is
account-plane ownership metadata, not a secret.

`GET /v1/account/tokens` accepts `limit` and `cursor`, and returns
`next_cursor`. The app reads pages until `next_cursor` is `null`.

## Usage

Cloud usage is charged to the owning user's account balance and keeps the
source Workspace as attribution metadata.

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

The Usage card uses both endpoints.

| UI value             | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| This month           | Sum of `usdMicros` for usage events in the month       |
| Cloud resource usage | Sum of `usdMicros` where `kind` starts with `gateway_` |
| Available balance    | Billing projection `balance.availableUsdMicros`        |
| Recent usage         | Newest usage events by `createdAt`                     |

Important usage kinds:

- `gateway_compute`
- `gateway_storage_gb_hour`
- `ai_request`
- `ai_input_token`
- `ai_output_token`
- `runner_minute`
- `operation`
- `artifact_storage_gb_hour`
- `backup_storage_gb_hour`
- `egress_gb`

Usage events carry quantity, usdMicros, source, and timestamp. They must not
carry provider credentials, API keys, bearer tokens, database URLs, DSNs,
passwords, or other secret values.

Cloud managed endpoints record usage into the owner account usage ledger and
preserve source Workspace attribution metadata. A success
that cannot be recorded must not be returned. If Workspace context is missing,
credits are insufficient, pricing is unavailable, or scopes do not match, the
request fails closed before it reaches the downstream provider, AI upstream, or
runtime dispatch.

Pricing is owned by Takosumi Cloud, not by endpoint request bodies. Requests and
client headers must not submit `usdMicros` or `credits`. Public prices and
free-tier terms are shown in [Takosumi Cloud pricing](./pricing.md) and
Dashboard billing views. Every active offering publishes exact SKU, unit, unit
price, minimum charge, tax policy, and catalog version in the public reference
and quote. Only synchronization procedures, secrets, and payment-provider
operation details stay in operator runbooks.

Cleanup is intentionally different from expansion. Create, deploy, runtime, and
data-plane write/query/message/instance operations are billable and fail closed
when credit is insufficient. DELETE cleanup should remain available so OpenTofu
destroy and app removal can recover from a depleted balance without leaving
resources stuck.

The Stable Cloudflare view contains only `cloudflare_workers_script`, a route on
its system hostname, and an R2 bucket. KV, D1, Queue, and Workflow may be
provider-neutral Preview service forms, but their Cloudflare-shaped routes
return 501. UI, billing, usage ledgers, and public Resource identity use service
forms such as `EdgeWorker` and `ObjectBucket` plus versioned SKUs. Internal
backend names do not become public billing families, and unsupported routes are
never proxied to Cloudflare.

Takosumi can claim a customer has been billed only when the owner account usage
ledger records a usage event and the billing projection reflects it. Upstream
provider charges alone do not mean Takosumi customer billing is complete.
Exact active PriceCatalog values are public; only payment-provider export and
reconciliation procedures and secrets belong in operator runbooks.

## AI Gateway

Base URL:

```text
https://app.takosumi.com/gateway/ai/v1
```

OpenAI-compatible routes:

```http
GET  /gateway/ai/v1/models
GET  /gateway/ai/v1/__takosumi/status
POST /gateway/ai/v1/chat/completions
POST /gateway/ai/v1/embeddings
```

OpenAI-compatible clients can use:

```bash
OPENAI_BASE_URL=https://app.takosumi.com/gateway/ai/v1
OPENAI_API_KEY=takpat_...
OPENAI_MODEL=takosumi/default
```

`takosumi/default` is the stable default alias. The operator may route that
alias to Cloudflare AI Gateway / Unified Billing, Workers AI, or another
OpenAI-compatible upstream. `/models` and status responses must return only
public model aliases and readiness metadata, never upstream keys or secret env
names.

## OpenTofu Import Endpoint

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

This is the Cloudflare v4-shaped subset for `compat.cloudflare.workers.v1`.
Existing `cloudflare/cloudflare` OpenTofu/Terraform provider configurations can
use it by changing `base_url`, but it is a protocol adapter, not a Cloudflare
account clone or Resource lifecycle authority.

The Stable control-plane subset is deliberately limited:

| Cloudflare-shaped operation                    | Canonical authority                       |
| ---------------------------------------------- | ----------------------------------------- |
| Worker script upload / list / read / delete    | `EdgeWorker` `/v1/resources` lifecycle    |
| Worker route CRUD on canonical system hostname | `http.route` Interface + InterfaceBinding |
| R2 bucket create / list / read / delete        | `ObjectBucket` `/v1/resources` lifecycle  |

Script and bucket mutations invoke canonical preview plus reviewed apply or
delete. Reads project the canonical Resource. The compatibility handler owns no
virtual resource ledger, backend manager, or Resource store. Even though
`KVStore`, `SQLDatabase`, `Queue`, and `DurableWorkflow` service forms are
Preview in Takosumi Cloud, their Cloudflare-shaped control routes are outside
the GA subset and return an explicit `501`.

Response envelope:

```json
{
  "success": true,
  "result": [],
  "errors": [],
  "messages": []
}
```

Principal Stable routes:

```http
GET /compat/cloudflare/client/v4/user/tokens/verify
GET /compat/cloudflare/client/v4/accounts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts
PUT /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts/{scriptName}
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts/{scriptName}
DELETE /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts/{scriptName}
GET|POST /compat/cloudflare/client/v4/zones/zone_takosumi_cloud/workers/routes
GET|PUT|DELETE /compat/cloudflare/client/v4/zones/zone_takosumi_cloud/workers/routes/{interfaceId}
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
```

A Worker deploy/read result includes `system_url`, projected from the Resource's
`url` Output. Clients discover this value instead of constructing it, then use a
separate operation for an optional route.

```json
{
  "result": {
    "script_name": "api",
    "phase": "Ready",
    "etag": "...",
    "system_url": "https://ew-abc.system.app.takos.jp/"
  }
}
```

A route pattern omits the scheme and combines the discovered system hostname
with an explicit path:

```json
{
  "pattern": "ew-abc.system.app.takos.jp/api/*",
  "script": "api"
}
```

On success, `id` is the canonical Interface id and `etag` is its strong ETag for
update and delete CAS:

```json
{
  "id": "if_route_xxx",
  "pattern": "ew-abc.system.app.takos.jp/api/*",
  "script": "api",
  "etag": "..."
}
```

The Stable subset permits one route per Worker, an explicit path, and zero or
one terminal wildcard. Host-only, multiple, overlapping, infix-wildcard,
wildcard-hostname, custom-hostname, script-subdomain, Worker secret / vars /
binding / assets, and multi-module upload requests fail before Interface or
Resource mutation. Route DELETE revokes the Binding and retires the Interface;
it does not release the system URL. Cloudflare billing API, DNS, WAF, Zero
Trust, account IAM, Registrar, Load Balancer, and Email Routing are outside the
compatibility scope. Custom domains remain Planned until ownership verification
and certificate lifecycle exist.
`previews_enabled: true` is outside the initial target scope.

## OpenTofu provider usage

Ordinary OpenTofu providers do not need registration in a provider catalog.
They all execute through `opentofu-default`; a Credential Recipe only assists
Connection setup. Providers without a recipe use a generic env/file Connection
according to the provider's own documentation. Built-in recipes are available
from `GET /api/v1/credential-recipes`.

Example Cloudflare provider configuration:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

The goal is to let the same Cloudflare Workers-oriented manifest target either
real Cloudflare or Takosumi Cloud. Switching belongs in Provider Binding /
Provider Connection, not in raw secrets inside the manifest. Do not put raw
secrets in manifests.

## Cloud resources inventory

The Cloud screen resource inventory projects the canonical `/v1/resources`
inventory. Stable offerings include at least:

- Edge Worker
- Object Storage

Preview service forms appear in the same inventory only when an active offering
exists. There is no virtual compatibility inventory or separate Resource
ledger. Dashboard, the `takosumi/takosumi` provider, direct Deploy API, and
supported compatibility requests all converge on the same Resource. The
`resource_shapes` capability means typed Resource Shape APIs are available; it
does not imply a separate managed-resource lifecycle.

## Security contract

Cloud endpoints follow these rules:

- Secret values are never redisplayed after creation
- Secret-shaped values are kept out of usage, catalog, status, and model metadata
- The platform worker verifies API key / session validity and read/write scope
- Cloud endpoints verify Workspace / account / virtual-account resource scope
- Unsupported routes fail closed instead of pretending success
- Cloud-only backends are not introduced into OSS Takosumi

## Availability

Cloud endpoint availability is advertised through the catalog and compatibility
matrix. If an endpoint family is not configured, the route must fail closed
instead of silently falling back to an unmanaged upstream or returning a fake
success.
