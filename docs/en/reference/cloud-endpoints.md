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

Official `app.takosumi.com` uses the closed
`takosumi-cloud/platform/worker.ts` wrapper as the Worker entry. The wrapper
mounts Cloud-only fetch handlers in-process into the OSS platform worker's
`cloud_extensions` seam. AI Gateway, the Cloudflare-compatible import endpoint,
the S3-compatible Object Storage endpoint, Cloud usage, and Cloud Edge Runtime
live in closed handlers; OSS code may contain catalog metadata, auth forwarding,
dashboard clients, and smoke tests. `handlerKey` is the logical handler key
consumed by the OSS seam and resolved in-process by the official Cloud wrapper.
This is one `takosumi-cloud/platform/worker.ts` deployment unit; AI Gateway, the
Cloudflare-compatible import endpoint, the S3-compatible Object Storage
endpoint, Cloud usage, and Cloud Edge Runtime are not deployed as separate
Workers. Managed resource backends are Takosumi Cloud closed modules.

## Catalog

Use this route to inspect enabled Cloud extensions:
The dashboard reads it with the account session cookie. Operator drills and
automation can also read it with the deploy-control bearer.

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
This catalog lists only path-based `cloud_extensions` routes.
`authMode: "handler"` is reserved for standard signed protocols such as S3
SigV4, where the Cloud handler must verify the protocol Authorization header
itself. In that mode, the platform does not verify a customer session/PAT; it
strips spoofable Takosumi context headers and cookies, then forwards the
`Authorization` header to the handler.
Takosumi Cloud public HTTP traffic for `*.app.takos.jp` and
`*.app-staging.takos.jp` is dispatched to the Cloud Edge Runtime by the same
`takosumi-cloud/platform/worker.ts` hostname dispatch registry. It is not a
separate Worker.

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
  "scopes": ["read", "write"]
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

Cloud extensions report billable runtime usage to the platform worker by adding
internal usage report headers to their response. The platform worker strips
those headers from the client response and records them through
`recordGatewayResourceUsage` in the Workspace usage ledger. If an extension
reports usage but the ledger write cannot be completed, the platform fails
closed instead of returning an unmetered success.

The public Cloud Edge Runtime is the exception only for usage reporting: it does
not expose usage headers to client responses. The Edge Runtime handler is still
mounted into the same official platform Worker. For a matched route with a
`spaceId`, it sends a `cloudflare:workers_script:request` meter to the platform
worker's internal `POST /internal/platform/cloud/usage` route before
dispatching the Workers Script. If the Workspace has insufficient credits,
pricing is missing, or the internal usage token is not configured, the Workers
Script is not dispatched.

Pricing is owned by the Takosumi Cloud platform worker, not by the Cloud
extension. The canonical extension report carries `meterId`, `kind`, `quantity`,
and resource metadata. Extension requests must not provide `usdMicros` or
`credits`; production pricing comes from the operator config
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`. The price book validates unit charge,
estimated unit cost, and minimum gross margin before it writes `usdMicros` to
the ledger. Unknown meters or prices below the required margin fail closed, so
WfP and AI requests cannot succeed without billable credit.
Public prices and free-tier terms are surfaced in the Cloud docs and Dashboard
billing views. The operator price-book values and change procedure stay in
operator notes, not in the public reference.

Cleanup is intentionally different from expansion. Create, deploy, runtime, and
data-plane write/query/message/instance operations are billable and fail closed
when credit is insufficient. DELETE cleanup does not emit fallback usage and must
remain available so OpenTofu destroy and app removal can recover from a depleted
balance without leaving resources stuck.

Internal headers:

```http
x-takosumi-cloud-usage-space-id: space_xxx
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T13:01:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"ai:default:request","kind":"ai_request","quantity":1}]
```

The Takosumi Cloud managed resource backend presents resources to users as
Cloudflare provider `cloudflare_workers_script`, routes, KV, R2, D1, Queues,
and Workflows. Internal backend names must not become the user-facing billing
or usage-ledger family. Worker script usage is reported with
`resourceFamily: "cloudflare.workers_script"` as `gateway_compute` or
`gateway_storage_gb_hour`. Queues are reported as `cloudflare.queues`, and
Workflows are reported as `cloudflare.workflows`. Subpaths for KV values, R2
objects, D1 query, Queue messages, Queue consumers, and Workflow instances are
opened only when the corresponding public meter and platform `fallbackUsage`
precharge coverage exist. R2 bucket lifecycle, object read/write operations,
and storage inventory are metered. R2 object DELETE is treated as cleanup and
intentionally emits no fallback usage meter so depleted credits do not strand
user data. Unsupported managed subpaths still return 501 instead of proxying to
Cloudflare for free.
Additional families such as Containers and Durable Objects can report
backend-measured usage through `/cloud/usage/resource-meters`. That billing
path does not by itself make the managed resource generally available: catalog
and UI exposure still require lifecycle endpoints, destroy / deprovision proof,
and runtime guard smoke evidence. Internal backend aliases are rejected in
`meterId`, `resourceFamily`, Stripe meters, and public usage metadata. Example:

```http
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:workers_script:request","resourceFamily":"cloudflare.workers_script","resourceId":"EdgeWorker/api","operation":"request","kind":"gateway_compute","quantity":1}]
```

For storage-backed resource inventory, the closed `takosumi-cloud`
`storageInventoryUsageReports()` helper converts provider inventory collector
average bytes plus a real period into GB-hour usage and reports it with the same
header shape.

The collector calls a Cloud-only extension endpoint, not a customer API. The
official Cloud wrapper mounts `/cloud/usage` to the closed Cloud usage handler
in-process, and the platform `TAKOSUMI_CLOUD_EXTENSIONS` config points to that
handler key. Official `app.takosumi.com` mounts the Cloud usage handler in the
same platform Worker.
The service token should carry a
usage-write scope. Requests are batched per Workspace; mixing multiple
Workspaces returns 400. If the verified billing Workspace context and the
sample `workspaceId` differ, the endpoint returns 403 and no usage is recorded.

```http
POST /cloud/usage/storage-inventory
```

```json
{
  "periodStart": "2026-06-26T13:00:00.000Z",
  "periodEnd": "2026-06-26T14:00:00.000Z",
  "samples": [
    {
      "workspaceId": "space_xxx",
      "resourceFamily": "cloudflare.r2",
      "resourceId": "ObjectStorage/assets",
      "averageBytes": 536870912
    }
  ]
}
```

```http
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T14:00:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:r2:storage_gb_hour","resourceFamily":"cloudflare.r2","resourceId":"ObjectStorage/assets","operation":"storage.inventory","kind":"gateway_storage_gb_hour","quantity":0.5}]
```

When a managed resource backend measures compute or operation usage, it submits
public meters to the `resource-meters` endpoint under the same `/cloud/usage`
extension. The endpoint currently accepts only `cloudflare.containers` and
`cloudflare.durable_objects`. A verified billing Workspace context is required;
request `workspaceId` values that do not match the verified context are
rejected. Callers must not send `usdMicros` or `credits`; the
platform worker prices each meter through `TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`.

```http
POST /cloud/usage/resource-meters
```

```json
{
  "workspaceId": "space_xxx",
  "periodStart": "2026-06-26T13:00:00.000Z",
  "periodEnd": "2026-06-26T13:01:00.000Z",
  "meters": [
    {
      "meterId": "cloudflare:containers:vcpu_second",
      "resourceFamily": "cloudflare.containers",
      "resourceId": "container:api",
      "operation": "vcpu_second",
      "kind": "gateway_compute",
      "quantity": 12.5
    },
    {
      "meterId": "cloudflare:durable_objects:operation",
      "resourceFamily": "cloudflare.durable_objects",
      "resourceId": "durable_object:session",
      "operation": "operation",
      "kind": "gateway_compute",
      "quantity": 3
    }
  ]
}
```

```http
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T13:01:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:containers:vcpu_second","resourceFamily":"cloudflare.containers","resourceId":"container:api","operation":"vcpu_second","kind":"gateway_compute","quantity":12.5}]
```

This ledger is the source input for billing reconciliation and Stripe invoices.
Upstream Cloudflare AI Gateway / Workers AI charges still land on the
operator's Cloudflare account; that alone does not mean the Takosumi customer
has been billed. Takosumi billing is closed only when the Cloud extension emits
usage reports, the Workspace usage ledger records them, and billing/Stripe
aggregates them into an invoice or entitlement decision.

Precise usage headers from the Cloud extension are the authoritative path. As a
leak-prevention fallback, when a successful request has a verified billing
Workspace context but no usage headers, the platform worker records minimal
operation usage instead of letting the request succeed for free. This fallback
is operation metering, not precise token or storage accounting. Cloudflare
Workers compatibility fallback usage is still recorded as
`cloudflare.workers_script`; internal backend names are not copied into usage
events.

The Stripe integration rolls up unexported usage reports by billing account,
meter, and unit, then creates Stripe invoice items for those rollups. After a
successful invoice item creation, the source usage reports are marked with
`billingExportProvider: "stripe"`, the export id, the Stripe invoice item id,
and the exported timestamp so the next sync does not charge the same reports
again. For Cloudflare Workers compatibility, the billing name remains
`cloudflare.workers_script`; internal backend aliases must not be used as the
billing name. Internal implementation hints such as `resourceMetadata.backend`
must not appear in public usage or billing payloads.

Operators trigger Stripe usage invoice item sync through the account-plane
`POST /v1/billing/stripe/usage-invoice-items` route. This is an operator-only
route, not a customer API, and requires the
`x-takosumi-billing-usage-sync-token` header. When the body includes
`usageEvents`, the route imports them as `BillingUsageRecord` rows through the
verified `workspaceId` BillingAccount before creating Stripe invoice items, so
the Cloud extension usage ledger stays connected to customer billing. Configure
`TAKOSUMI_STRIPE_USAGE_INVOICE_ITEM_PRICES` as a JSON array of meter / unit /
unitAmount / currency mappings, for example:

```json
[
  {
    "meter": "cloudflare.workers_script",
    "unit": "requests",
    "unitAmount": 4,
    "currency": "usd"
  }
]
```

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

## Implementation status

The OSS repository contains:

- platform route catalog
- same-origin session / PAT / service-token auth forwarding
- AI Gateway OpenAI-compatible handler seam
- dashboard Cloud endpoint client
- smoke tests and provider E2E expectations

The Cloudflare Compatibility backend and managed resource materialization are
closed Takosumi Cloud handlers mounted in-process by the official platform worker.
If AI Gateway / Cloudflare Compatibility handlers are not configured,
`/gateway/ai/v1/*` and `/compat/cloudflare/client/v4/*` intentionally return
not found from the platform worker.
