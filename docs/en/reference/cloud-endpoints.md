# Takosumi Cloud endpoints

Takosumi Cloud endpoints are Cloud-only managed services. They are not part of
the Takosumi OSS or Takosumi for Operators public contract.

The app screen should show operational facts that people need day to day. The
full endpoint contract, scope, and examples live in this document.

## App and docs split

`app.takosumi.com/cloud` prioritizes:

- creating, listing, and revoking API keys
- this month's usage, Gateway usage, and available credits
- AI Gateway base URL, default model, and public model aliases
- Cloudflare Compatibility API base URL and current account
- KV / Object Storage / Database / Worker inventory in Takosumi Cloud

The app does not carry the full specification. Provider compatibility scope,
OpenTofu provider examples, usage event contracts, and secret-handling rules
belong in docs.

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
  "serviceUrl": "https://app.takosumi.com",
  "extensions": [
    {
      "id": "ai.openai_compatible.v1",
      "kind": "ai_gateway",
      "basePath": "/gateway/ai/v1",
      "configured": true
    },
    {
      "id": "provider.cloudflare.client_v4",
      "kind": "provider_compat",
      "provider": "cloudflare",
      "basePath": "/compat/cloudflare/client/v4",
      "configured": true
    }
  ]
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

List responses must not expose the secret value again. Safe metadata includes
`prefix`, `scopes`, `created_at`, `expires_at`, `revoked_at`, and
`last_used_at`.

## Usage

Cloud usage is recorded as Workspace-scoped usage events.

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

The Usage card uses both endpoints.

| UI value          | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| This month        | Sum of `credits` for usage events in the month      |
| Gateway usage     | Sum of `credits` where `kind` starts with `gateway_` |
| Available credits | Billing projection `balance.availableCredits`       |
| Recent usage      | Newest usage events by `createdAt`                  |

Important usage kinds:

- `gateway_compute`
- `gateway_storage_gb_hour`
- `runner_minute`
- `operation`
- `artifact_storage_gb_hour`
- `backup_storage_gb_hour`
- `egress_gb`

Usage events carry quantity, credits, source, and timestamp. They must not
carry provider credentials, API keys, bearer tokens, database URLs, DSNs,
passwords, or other secret values.

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
- billing
- registrar
- load balancer
- email routing
- Turnstile

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
- verify API keys by account / Workspace scope and endpoint scope
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
closed Takosumi Cloud service bindings. If the binding is not configured,
`/compat/cloudflare/client/v4/*` intentionally returns not found from the
platform worker.
