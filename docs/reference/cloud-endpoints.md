# Takosumi Cloud endpoints

Takosumi Cloud endpoints are Cloud-only managed services. They are not part of
Takosumi OSS or Takosumi for Operators.

The dashboard should show operational facts: API keys, base URLs, usage, and
current Cloud resources. The full contract lives here.

## Boundary

Takosumi OSS runs existing OpenTofu/Terraform providers as-is.

Takosumi Cloud adds:

- AI Gateway
- Cloudflare Compatibility API
- managed resource backends
- official usage, quota, billing, and support controls

The platform worker at `app.takosumi.com` owns the public route families and
delegates Cloud-only implementation to closed service bindings. OSS code may
contain catalog metadata, auth forwarding, dashboard clients, and smoke tests,
but the managed resource backend is Cloud-only.

## Catalog

```http
GET /__takosumi/cloud/extensions
```

Returns the Cloud-only extension catalog for the current deployment.

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

## API keys

Dashboard-created Cloud API keys are Takosumi Accounts personal access tokens.
They are returned only once on creation.

```http
GET  /v1/account/tokens
POST /v1/account/tokens
POST /v1/account/tokens/{tokenId}/revoke
```

Default Cloud endpoint keys should use:

```json
{
  "scopes": ["read", "write"]
}
```

`read` is enough for `GET`/`HEAD`/`OPTIONS`. `write` is required for mutating
Cloud endpoints such as creating or updating compatibility resources. `admin`
is not needed for normal Cloud endpoint use.

Secret values are not shown again after creation. List responses expose only
metadata such as `prefix`, `scopes`, `created_at`, `expires_at`,
`revoked_at`, and `last_used_at`.

## AI Gateway

Base URL:

```text
https://app.takosumi.com/gateway/ai/v1
```

OpenAI-compatible endpoints:

```http
GET  /gateway/ai/v1/models
GET  /gateway/ai/v1/__takosumi/status
POST /gateway/ai/v1/chat/completions
POST /gateway/ai/v1/embeddings
```

Clients can use:

```bash
OPENAI_BASE_URL=https://app.takosumi.com/gateway/ai/v1
OPENAI_API_KEY=takpat_...
```

The public model id `takosumi/default` is the stable default alias. The
operator may route it to Cloudflare AI Gateway / unified billing, Workers AI,
or another configured OpenAI-compatible upstream. Model metadata returned from
`/models` must not contain secret values.

## Cloudflare Compatibility API

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

The endpoint is a Cloudflare v4-compatible subset for Workers-oriented
resources. It is intended for the `cloudflare/cloudflare` OpenTofu/Terraform
provider by setting provider `base_url`.

Supported response envelope:

```json
{
  "success": true,
  "result": [],
  "errors": [],
  "messages": []
}
```

Read-only dashboard inventory uses:

```http
GET /compat/cloudflare/client/v4/user/tokens/verify
GET /compat/cloudflare/client/v4/accounts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts
GET /compat/cloudflare/client/v4/accounts/{accountId}/storage/kv/namespaces
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
GET /compat/cloudflare/client/v4/accounts/{accountId}/d1/database
```

The compatibility target is Workers-oriented:

- Workers scripts
- Workers routes
- KV namespaces
- R2 buckets
- D1 databases
- Worker vars, secrets, and bindings

Out of scope for the initial compatibility API:

- DNS as a full product
- WAF and Rulesets
- Zero Trust
- account IAM
- billing
- registrar
- load balancers
- email routing
- Turnstile

## OpenTofu provider usage

Example provider configuration:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

The same Cloudflare Workers-oriented manifest can target real Cloudflare or
Takosumi Cloud by changing the Provider Binding / Provider Connection. The
manifest should not contain raw secrets.

## Usage

Cloud usage is recorded as Workspace-scoped usage events.

Current dashboard usage is read from:

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

Important usage kinds:

- `gateway_compute`
- `gateway_storage_gb_hour`
- `runner_minute`
- `operation`
- `artifact_storage_gb_hour`
- `backup_storage_gb_hour`
- `egress_gb`

Usage events carry quantity, credits, source, and timestamp. They must not
carry provider credentials, API keys, bearer tokens, database URLs, or other
secret values.

## Implementation status

The OSS repository currently contains:

- platform route catalog
- same-origin session / PAT / service-token auth forwarding
- AI Gateway OpenAI-compatible handler implementation
- dashboard Cloud endpoint client
- smoke tests and provider E2E expectations

The Cloudflare Compatibility backend that materializes managed resources is a
closed Takosumi Cloud service binding. If that binding is not configured,
`/compat/cloudflare/client/v4/*` intentionally returns not found from the
platform worker.
