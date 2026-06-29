# Takosumi Cloud endpoints

Takosumi Cloud endpoints are Cloud-only managed services. They are not part of
the Takosumi OSS or Takosumi for Operators public contract.

The app screen should show operational facts that people need day to day: API
keys, connection health, this month's usage, balance, and current resource
counts. The full endpoint contract, scope, and examples live in this document.

## App and docs split

`app.takosumi.com/cloud` is a screen focused on managing API keys and resources.

- creating, listing, and revoking API keys
- Cloud resources (KV / Object Storage / Database / Workers): list, copy IDs,
  and delete
- AI Gateway base URL, connection health, and default model
- Cloudflare Compatibility API base URL and current account

Usage and billing live on Billing (`app.takosumi.com/billing`), not on the Cloud
screen:

- this month's usage, Cloud resource usage, and available balance
- usage history (the usage event ledger)

Deleting a resource calls the compat gateway's DELETE. It requires a
`write`-scoped session and only takes effect when the Cloud backend has
materialized it; otherwise the gateway answers 501 fail-closed. The app does not
carry the full specification — provider compatibility scope, OpenTofu provider
examples, usage event contracts, and secret-handling rules belong in docs.

## Boundary

Takosumi OSS runs existing OpenTofu/Terraform providers as-is.

Only Takosumi Cloud has:

- AI Gateway
- Cloudflare Compatibility API
- managed resource backends
- official usage, quota, billing, and support controls

The platform worker at `app.takosumi.com` exposes Cloud-only route families and
delegates implementation to closed service bindings. OSS code may contain
catalog metadata, auth forwarding, dashboard clients, and smoke tests. Managed
resource backends are Takosumi Cloud closed modules.

## Catalog

Use this route to inspect enabled Cloud extensions:

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
      "basePath": "/gateway/ai/v1",
      "configured": true,
      "requiredScopes": ["ai.chat", "ai.embeddings"]
    },
    {
      "basePath": "/compat/cloudflare/client/v4",
      "configured": true,
      "requiredScopes": ["read", "write"]
    },
    {
      "basePath": "/cloud/usage",
      "configured": true,
      "requiredScopes": ["cloud.usage.write"]
    }
  ],
  "summary": {
    "total": 3,
    "configured": 3,
    "missing": 0
  }
}
```

An extension with `configured: false` may appear in the UI, but runtime calls
must fail closed.

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

Pricing is owned by the Takosumi Cloud platform worker, not by the Cloud
extension. The canonical extension report carries `meterId`, `kind`, `quantity`,
and resource metadata. Extension-provided `usdMicros` is still accepted as a
legacy/fallback compatibility path, but production pricing comes from the
operator config `TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`. The price book validates
unit charge, estimated unit cost, and minimum gross margin before it writes
`usdMicros` to the ledger. Unknown meters or prices below the required margin
fail closed, so WfP and AI requests cannot succeed without billable credit.
The operating source of truth for prices and the free tier is
`docs/operations/cloud-pricing.md`.

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
Workflows are reported as `cloudflare.workflows`. Additional families such as
Containers and Durable Objects are added to the catalog, UI, and billing prices
only after the closed Gateway backend proves lifecycle endpoints and usage
smoke coverage for them. Internal backend aliases are rejected in `meterId`,
`resourceFamily`, Stripe meters, and public usage metadata. Example:

```http
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:workers_script:request","resourceFamily":"cloudflare.workers_script","resourceId":"script:api","operation":"request","kind":"gateway_compute","quantity":1,"installationId":"inst_xxx"}]
```

For storage-backed resource inventory, the closed `takosumi-cloud`
`storageInventoryUsageReports()` helper converts provider inventory collector
average bytes plus a real period into GB-hour usage and reports it with the same
header shape.

The collector calls a Cloud-only extension endpoint, not a customer API. The
platform `TAKOSUMI_CLOUD_EXTENSIONS` config routes `/cloud/usage` to the closed
`takosumi-cloud-usage` service binding, and the service token should carry a
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
      "installationId": "inst_xxx",
      "resourceFamily": "cloudflare.r2",
      "resourceId": "bucket:assets",
      "averageBytes": 536870912
    }
  ]
}
```

```http
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T14:00:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:r2:storage_gb_hour","resourceFamily":"cloudflare.r2","resourceId":"bucket:assets","operation":"storage.inventory","kind":"gateway_storage_gb_hour","quantity":0.5,"installationId":"inst_xxx"}]
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
ready Installation projection's `billingAccountId` before creating Stripe
invoice items, so the Cloud extension usage ledger stays connected to customer
billing. Configure
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

## Cloudflare Compatibility API

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

This is a Cloudflare v4-compatible subset. It lets the `cloudflare/cloudflare`
OpenTofu/Terraform provider point Workers-oriented resources at Takosumi Cloud
managed resources by changing provider `base_url`.

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
is the Compatibility API plus the OpenTofu provider plan/apply result.

## Security contract

Cloud endpoints must:

- never redisplay secret values after creation
- keep secret-shaped values out of usage, catalog, status, and model metadata
- have the platform worker verify API key / session validity and read/write scope
- have the closed binding verify Workspace / account / virtual-account resource scope
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
closed Takosumi Cloud service bindings. If AI Gateway / Cloudflare
Compatibility bindings are not configured, `/gateway/ai/v1/*` and
`/compat/cloudflare/client/v4/*` intentionally return not found from the
platform worker.
