# Takosumi Cloud endpoints

Takosumi Cloud endpoints are Cloud-only routes/handlers plus managed-resource
backends. They are not part of the Takosumi OSS or Takosumi for Operator
public contract.

Use [Takosumi Cloud](../cloud/index.md) and
[Takosumi Cloud resources](./cloud-resources.md) as the public product docs. This
page is the detailed reference for endpoints, usage, API keys, and compatibility
routes.

The app screen should show operational facts that people need day to day: API
keys, connection health, this month's usage, balance, and current resource
counts. The full endpoint contract, scope, and examples live in this document.

## App and docs split

`app.takosumi.com/cloud` is a screen focused on managing API keys and resources.

- creating, listing, and revoking API keys
- Cloud resources (KV / Object Storage / Database / Workers): list, copy IDs,
  and delete
- AI Gateway base URL, connection health, and default model
- OpenTofu import endpoint base URL and current virtual account
- Object Storage endpoint base URL and S3-compatible bucket configuration health

Usage and billing live on Billing (`app.takosumi.com/billing`), not on the Cloud
screen:

- this month's usage, Cloud resource usage, and available balance
- usage history (the usage event ledger)

Deleting a resource calls the compatible import endpoint's DELETE. It requires a
`write`-scoped session and only takes effect when the Cloud backend has
materialized it; otherwise the endpoint answers 501 fail-closed. DELETE cleanup is
not a billable fallback operation, so a Workspace that has run out of credit can
still destroy or remove already-created managed resources. The app does not carry
the full specification — provider compatibility scope, OpenTofu provider
examples, usage event contracts, and secret-handling rules belong in docs.

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

Official `app.takosumi.com` mounts Cloud-only handlers on the same hosted
platform origin. AI Gateway, the Cloudflare-compatible import endpoint, the
S3-compatible Object Storage endpoint, Cloud usage, and Cloud Edge Runtime are
served by Takosumi Cloud managed backends. Managed-backend implementation
details, secrets, private config, and operator evidence are not public
contracts; they belong in operator runbooks.

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

An extension with `configured: false` may appear in the UI, but runtime calls
must fail closed.
This catalog lists only public endpoints and capabilities.
`authMode: "handler"` is reserved for standard signed protocols such as S3
SigV4, where the Cloud handler must verify the protocol Authorization header
itself. In that mode, the platform does not verify a customer session/PAT; it
strips spoofable Takosumi context headers and cookies, then forwards the
`Authorization` header to the handler.
Takosumi Cloud public HTTP traffic for `*.app.takos.jp` and
`*.app-staging.takos.jp` is dispatched to the Cloud Edge Runtime by the same
hosted-origin hostname dispatch registry.

## API key / Workspace billing context

The Resource Shape API used by the `takosumi` provider (`/v1/resources`,
`/v1/target-pools`, and `/v1/space-policies`) and the Cloudflare-compatible
import endpoint (`/compat/cloudflare/client/v4`) can be used without creating a
Capsule / app installation first. They are not anonymous endpoints. A request
must authenticate with an account session, personal access token, or service
token, and the billing Workspace must be verified.

Sessions and personal access tokens may select the billing Workspace with
`x-takosumi-cloud-billing-workspace-id`. The platform verifies that the token
can read that Workspace in the accounts plane before forwarding to the Cloud
handler or Resource Shape API. For OpenTofu providers such as the Cloudflare
provider that do not conveniently attach arbitrary headers, create the personal
access token with `workspace_id`. The platform then uses the token
introspection `takosumi.space_id` as the default billing Workspace, so provider
configuration only needs `api_token` and `base_url`. Service tokens may only
use the Workspace encoded in token metadata.

Billable writes are precharged against Workspace credits before forwarding. If
the Workspace context is missing, the token does not match the Workspace, or the
Workspace has insufficient credits, the request fails closed and is not
forwarded to the downstream handler / apply path. Capsule / installation ids are
optional. When omitted, provider / compatibility API usage is recorded as a
Workspace usage event without `installationId`.

## S3-compatible Object Storage endpoint

The S3-compatible endpoint is the data-plane for Object Storage provided by
Takosumi Cloud. It lets existing S3 SDKs and S3-compatible OpenTofu providers
consume Takosumi Cloud storage. It is not full AWS API compatibility; the public
scope is the `compat.s3.v1` capability.

```http
GET  /compat/s3/v1/__takosumi/status
GET  /compat/s3/v1
HEAD /compat/s3/v1/{bucket}
PUT  /compat/s3/v1/{bucket}
GET  /compat/s3/v1/{bucket}?list-type=2
GET  /compat/s3/v1/{bucket}/{key}
HEAD /compat/s3/v1/{bucket}/{key}
PUT  /compat/s3/v1/{bucket}/{key}
DELETE /compat/s3/v1/{bucket}/{key}
```

Normal Cloud API keys (Takosumi Accounts personal access tokens) are not S3 SDK
credentials. The S3-compatible endpoint verifies AWS SigV4 access key / secret
access key credentials. Each access key is scoped to a Workspace and optional
bucket allowlist, while bucket descriptors come from the Cloud realized config
or managed-resource backend.

`GET /compat/s3/v1/__takosumi/status` is readable without SigV4 and reports
operational configuration health. The dashboard uses it to show configured
bucket counts.

Read/write/list operations precharge through the Cloud usage ledger. If the
Workspace USD balance is exhausted, `PUT` fails with `402 PaymentRequired`
before backend storage is mutated. `DELETE` cleanup intentionally has no
operation precharge so users can remove already-created managed resources even
when their balance is exhausted.

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

Cloud usage is recorded as Workspace-scoped usage events.

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

Cloud managed endpoints record usage into the Workspace usage ledger. A success
that cannot be recorded must not be returned. If Workspace context is missing,
credits are insufficient, pricing is unavailable, or scopes do not match, the
request fails closed before it reaches the downstream provider, AI upstream, or
runtime dispatch.

Pricing is owned by Takosumi Cloud, not by endpoint request bodies. Requests and
client headers must not submit `usdMicros` or `credits`. Public prices and
free-tier terms are shown in Cloud docs and Dashboard billing views. The real
price book, sync procedure, and payment-provider operation details belong in
operator notes, not in the public reference.

Cleanup is intentionally different from expansion. Create, deploy, runtime, and
data-plane write/query/message/instance operations are billable and fail closed
when credit is insufficient. DELETE cleanup should remain available so OpenTofu
destroy and app removal can recover from a depleted balance without leaving
resources stuck.

The Takosumi Cloud managed resource backend presents resources to users as
Cloudflare provider `cloudflare_workers_script`, routes, KV, R2, D1, Queues,
and Workflows. Internal backend names must not become the user-facing billing
or usage-ledger family. Unsupported managed subpaths return 501 instead of
proxying to Cloudflare for free.

Takosumi can claim a customer has been billed only when the Workspace usage
ledger records a usage event and the billing projection reflects it. Upstream
provider charges alone do not mean Takosumi customer billing is complete.
Payment-provider export, reconciliation, operator tokens, and concrete price
book values are operator-runbook concerns, not customer APIs.

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

This is the Cloudflare v4-shaped subset for `compat.cloudflare.workers.v1`. It
lets the `cloudflare/cloudflare` OpenTofu/Terraform provider point
Workers-oriented resources at Takosumi Cloud `EdgeWorker` / managed bindings by
changing provider `base_url`. It is an import and deploy path for existing
manifests, not full Cloudflare API compatibility.

Response envelope:

```json
{
  "success": true,
  "result": [],
  "errors": [],
  "messages": []
}
```

Read routes used by dashboard inventory:

```http
GET /compat/cloudflare/client/v4/user/tokens/verify
GET /compat/cloudflare/client/v4/accounts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts
GET /compat/cloudflare/client/v4/accounts/{accountId}/storage/kv/namespaces
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
GET /compat/cloudflare/client/v4/accounts/{accountId}/d1/database
```

Initial target scope:

- Workers scripts
- Workers routes
- default `*.app.takos.jp` hostname per HTTP route
- user-owned custom domains on HTTP routes
- KV namespaces
- R2 buckets
- D1 databases
- Worker vars, secrets, and bindings

Not in the initial target:

- full DNS product
- WAF / Rulesets
- Zero Trust
- account IAM
- Cloudflare billing API
- registrar
- load balancer
- email routing
- Turnstile

Cloudflare billing API compatibility is out of scope. Takosumi Cloud managed
resource usage must be recorded through the Workspace usage ledger above, not by
proxying Cloudflare's billing API.

Workers route records carry hostname fields:

Request:

```json
{
  "pattern": "my-app.app.takos.jp/*",
  "script": "api",
  "app_subdomain": "my-app",
  "custom_domains": ["api.example.com"]
}
```

Response:

```json
{
  "id": "route_xxx",
  "pattern": "my-app.app.takos.jp/*",
  "script": "api",
  "default_hostname": "my-app.app.takos.jp",
  "custom_domains": ["api.example.com"]
}
```

`default_hostname` is the immediately usable Takosumi-managed URL. It can be
requested with `app_subdomain`, `default_hostname`, or `hostname`. If omitted,
Takosumi issues `<app-slug>-<short-id>.app.takos.jp`. The `*.app.takos.jp`
namespace is first-come-first-served; duplicate reservations return 409.
`custom_domains` are user-owned domains. DNS ownership verification,
certificate provisioning, and runtime dispatch activation are Cloud runtime
responsibilities. Unverified custom domains are not activated for runtime
dispatch, and the default hostname remains available.

## OpenTofu provider usage

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
Provider Connection, not in raw secrets inside the manifest.

## Cloud resources inventory

The Cloud screen resource inventory is an operational summary read through the
Compatibility API. It should show at least:

- KV
- Object Storage
- Database
- Workers

Inventory is for operational inspection. The authoritative lifecycle contract
is the Compatibility API plus the Cloudflare-compatible OpenTofu provider
plan/apply result. The `takosumi/takosumi` provider Resource Shape API
(`/v1/resources/*`) is a separate surface and is advertised through the
`resource_shapes` capability only when the production host mounts a real
ResourceShape adapter and routes it.

## Security contract

Cloud endpoints must:

- never redisplay secret values after creation
- keep secret-shaped values out of usage, catalog, status, and model metadata
- have the platform worker verify API key / session validity and read/write scope
- have the closed handler verify Workspace / account / virtual-account resource scope
- fail closed for unsupported routes instead of pretending success
- keep Cloud-only backends out of OSS Takosumi

## Availability

Cloud endpoint availability is advertised through the catalog and compatibility
matrix. If an endpoint family is not configured, the route must fail closed
instead of silently falling back to an unmanaged upstream or returning a fake
success.
