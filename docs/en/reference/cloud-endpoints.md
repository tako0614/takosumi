# Takosumi Cloud endpoints

Takosumi Cloud endpoints are Cloud-only managed services. They are not part of
Takosumi OSS or Takosumi for Operators.

The dashboard shows operational facts: API keys, base URLs, usage, and current
Cloud resources. This page is the contract reference.

## Boundary

Takosumi OSS runs existing OpenTofu/Terraform providers as-is.

Takosumi Cloud adds:

- AI Gateway
- Cloudflare Compatibility API
- managed resource backends
- official usage, quota, billing, and support controls

The platform worker at `app.takosumi.com` owns the public route families and
delegates Cloud-only implementation to closed service bindings.

## API keys

Dashboard-created Cloud API keys are Takosumi Accounts personal access tokens.
They are returned only once on creation.

```http
GET  /v1/account/tokens
POST /v1/account/tokens
POST /v1/account/tokens/{tokenId}/revoke
```

Default Cloud endpoint keys use `read` and `write`. `admin` is not needed for
normal Cloud endpoint use.

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

`takosumi/default` is the stable default model alias.

## Cloudflare Compatibility API

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

Dashboard inventory uses:

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

The initial compatibility API does not cover DNS as a full product, WAF,
Rulesets, Zero Trust, account IAM, billing, registrar, load balancers, email
routing, or Turnstile.

## Usage

Cloud usage is recorded as Workspace-scoped usage events.

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

Usage events carry quantity, credits, source, and timestamp. They must not
carry provider credentials, API keys, bearer tokens, database URLs, or other
secret values.

## Implementation status

The OSS repository contains the platform route catalog, auth forwarding, AI
Gateway handler, dashboard client, smoke tests, and provider E2E expectations.
The Cloudflare Compatibility backend that materializes managed resources is a
closed Takosumi Cloud service binding.
