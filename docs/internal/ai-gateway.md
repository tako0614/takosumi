# AI Gateway

Takosumi AI Gateway is a **Takosumi Cloud-only closed extension**, not a
Takosumi OSS control-plane feature. OSS Takosumi remains an OpenTofu/Terraform
control plane that runs existing providers as-is; it does not provide model
gateway services as part of the public OSS contract.

This page describes the official hosted data-plane implementation. AI Gateway
is not a default Resource Shape and is not exposed as a dedicated provider
resource.
Apps consume it as an OpenAI-compatible endpoint through runtime environment
projection:

```text
OPENAI_BASE_URL=https://<issuer>/gateway/ai/v1
OPENAI_API_KEY=<rotated service token>
OPENAI_MODEL=takosumi/default
```

The `takosumi` OpenTofu provider must not treat the official Cloud upstream
list as a global AI provider allow-list. Upstream choices and routing belong to
the closed Cloud handler or to an operator-provided runtime service.

The Cloud extension is a Takosumi Cloud operator-backed, OpenAI-compatible
runtime profile. It lets a deployed Capsule runtime use one Takosumi endpoint
and one rotated runtime service token while Takosumi Cloud keeps operator-held
AI credentials in platform secrets.
For Cloudflare Unified Billing that credential is a Cloudflare API token; for
direct/BYOK profiles it is the provider API key. The OSS platform worker
carries only a fail-closed route seam and an optional Cloud-extension fetch
handler handoff. In official Takosumi Cloud, the closed
`takosumi-cloud/platform/worker.ts` wrapper mounts that handler in-process
around the OSS platform worker. The platform Cloud extension registry is
operator-configured. In official Takosumi Cloud it currently includes this AI
Gateway, the `compat.cloudflare.workers.v1` import path, and the scoped
`compat.s3.v1` object-storage data-plane when configured. Upstream profiles,
operator-held credentials, and request forwarding belong to the closed Takosumi
Cloud deployment.

For the current GA scope, Takosumi Cloud extension routes are limited to scoped
capability routes that have their own contracts. OSS compatibility profiles
remain scoped, versioned Takosumi capabilities outside this AI Gateway
contract.

The platform route is active only when the closed Cloud wrapper mounts the AI
Gateway fetch handler. The wrapper exposes that handler to the OSS
`cloud_extensions` seam through the `TAKOSUMI_CLOUD_AI_GATEWAY` handler key, so
official staging/production `app.takosumi.com` remains one platform Worker.
Without a mounted handler,
`/gateway/ai/v1/*` intentionally returns `404`.

It is not an OpenTofu provider credential and it is not an OpenTofu output secret. OpenTofu provisions and deploys the
service that will consume the model API; runtime model access is granted after deployment through
`takosumi.ai.gateway`.

## Cloud Extension Contract

Runtime service projection:

- service id: `takosumi.ai.gateway`
- capability: `ai.model`
- endpoint: `/gateway/ai/v1`
- additional material capabilities: `ai.embedding_model`, `protocol.http.api`
- default public model alias: `takosumi/default`
- recommended runtime env:
  - `OPENAI_BASE_URL=https://<issuer>/gateway/ai/v1`
  - `OPENAI_API_KEY=<rotated service token>`
  - `OPENAI_MODEL=takosumi/default`

OpenAI-compatible routes:

| route                                  | scope            | behavior                                 |
| -------------------------------------- | ---------------- | ---------------------------------------- |
| `GET /gateway/ai/v1/models`            | `ai.models.read` | lists public model aliases               |
| `GET /gateway/ai/v1/__takosumi/status` | `ai.models.read` | reports secret-free gateway readiness    |
| `POST /gateway/ai/v1/chat/completions` | `ai.chat`        | forwards chat completions to an upstream |
| `POST /gateway/ai/v1/embeddings`       | `ai.embeddings`  | forwards embeddings to an upstream       |

Runtime calls should use a current `takosumi.ai.gateway` runtime service token
as `Authorization: Bearer <taksrv_...>`. The platform worker introspects that
token with the Cloud extension confidential client, verifies the endpoint
scope, strips the raw bearer token, and forwards only a sanitized request to the
closed AI Gateway handler. Failed auth or insufficient-scope requests are
forwarded without raw account/session/service credentials and without the
pre-authenticated header, so the downstream handler fails closed without seeing
the original credential.
Operator/dashboard sessions and Takosumi personal access tokens are accepted
only for owner/operator smoke and diagnostics; deployed Capsule runtimes should
not receive account sessions, PATs, Cloudflare API tokens, or direct upstream
provider keys.

## Billing and Metering

For the preferred Cloudflare Unified Billing profile, upstream model cost is
charged to the Takosumi Cloud operator's Cloudflare account. That is only the
upstream cost path. It is not sufficient evidence that the Takosumi customer has
been billed.

The closed AI Gateway handler must report billable usage back to the platform
worker with the Cloud extension usage report headers. The platform worker strips
those headers before returning the response and records them in the Workspace
usage ledger. Supported AI meter kinds are:

- `ai_request`
- `ai_input_token`
- `ai_output_token`

Example internal report:

```http
x-takosumi-cloud-usage-space-id: space_xxx
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T13:01:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"ai:takosumi-default:request","kind":"ai_request","quantity":1}]
```

If these headers are present but the ledger write fails, the platform route
fails closed with `502` rather than returning an unmetered success. Billing and
Stripe reconciliation use the Workspace usage ledger as the source of truth.

Tokens are rotated through the account-plane Capsule projection route:

```text
POST /v1/capsule-projections/:capsuleId/services/takosumi.ai.gateway/rotate-token
```

This is a supporting runtime-token vending route for the hosted Cloud extension,
not a stable Takosumi OSS customer API or a restored service catalog.

Body:

```json
{
  "scopes": ["ai.models.read", "ai.chat", "ai.embeddings"]
}
```

If `scopes` is omitted, the gateway token receives all three endpoint scopes. A narrower token can be issued for a
service that only needs model listing or chat completions.

## Cloud Extension Configuration

The closed Takosumi Cloud AI Gateway handler reads upstream profiles from
`TAKOSUMI_AI_GATEWAY_PROFILES`. This is config, not a secret. The handler is
mounted through the `cloud_extensions` seam by the official
`takosumi-cloud/platform/worker.ts` wrapper; it is not deployed as an
independent Worker. Each profile is either an OpenAI-compatible HTTPS upstream
that names the env/secret containing its upstream credential, or a Cloudflare
Workers AI binding profile that uses the Cloudflare Worker `AI` binding and
therefore has no upstream REST credential. For Takosumi Cloud, the preferred
operator-paid sandbox path is a Cloudflare AI Gateway REST API profile backed by
Cloudflare Unified Billing: the secret is a Cloudflare API token, and Cloudflare
bills the configured provider credits. The OSS platform worker does not parse
this config or forward model requests by itself.

Takosumi customer billing is explicit and separate from upstream provider
billing. A model may set `billingUsdMicrosPerRequest`,
`billingUsdMicrosPerMillionInputTokens`, and
`billingUsdMicrosPerMillionOutputTokens`. Successful attributed
`chat.completions` and `embeddings` calls then emit an internal Cloud extension
usage report with `ai_request`, and, when the upstream response includes an
OpenAI-compatible `usage` object, `ai_input_token` / `ai_output_token`.
Production pricing is finalized by the platform worker's
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`; model-level `billingUsdMicros*` values are
accepted for closed AI Gateway fallback/compatibility and local tests, but the
operator price book is the Cloud pricing source of truth. The platform worker
records the priced report in the Workspace usage ledger and strips the internal
headers before returning the client response. If the auth context has no
`spaceId`, the AI Gateway does not emit a usage report because the request
cannot be billed to a Workspace.

`workers_ai_binding` profiles may set `gateway.id` to route `env.AI.run()`
through Cloudflare AI Gateway from inside the Worker. Use `default` unless the
operator has explicitly created a named gateway in the same Cloudflare account.
The optional `gateway.metadata` object is public routing/log metadata only and
is rejected if it contains secret-shaped keys or values.

```json
[
  {
    "type": "openai_compatible",
    "id": "cloudflare-unified",
    "provider": "cloudflare_unified_billing",
    "baseUrl": "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1",
    "apiKeyEnv": "CLOUDFLARE_API_TOKEN",
    "headers": {
      "cf-aig-gateway-id": "default"
    },
    "models": [
      {
        "publicModel": "takosumi/default",
        "upstreamModel": "openai/gpt-4.1-mini",
        "endpoints": ["chat.completions"],
        "default": true,
        "billingClass": "operator-paid-preview",
        "billingUsdMicrosPerRequest": 1000,
        "billingUsdMicrosPerMillionInputTokens": 300000,
        "billingUsdMicrosPerMillionOutputTokens": 1000000
      },
      {
        "publicModel": "anthropic/sonnet",
        "upstreamModel": "anthropic/claude-sonnet-4-5",
        "endpoints": ["chat.completions"],
        "billingUsdMicrosPerRequest": 500000
      }
    ]
  },
  {
    "type": "workers_ai_binding",
    "id": "workers-ai",
    "provider": "workers_ai",
    "gateway": {
      "id": "default",
      "collectLog": true,
      "metadata": {
        "surface": "takosumi-cloud"
      }
    },
    "models": [
      {
        "publicModel": "workers-ai/llama-3.1-8b-instruct-fast",
        "upstreamModel": "@cf/meta/llama-3.1-8b-instruct-fast",
        "endpoints": ["chat.completions"],
        "default": true,
        "billingUsdMicrosPerRequest": 50000
      },
      {
        "publicModel": "workers-ai/bge-base-en-v1.5",
        "upstreamModel": "@cf/baai/bge-base-en-v1.5",
        "endpoints": ["embeddings"]
      }
    ]
  },
  {
    "type": "openai_compatible",
    "id": "deepseek",
    "provider": "deepseek",
    "baseUrl": "https://provider.example/v1",
    "apiKeyEnv": "TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
    "models": [
      {
        "publicModel": "deepseek/chat",
        "upstreamModel": "deepseek-chat",
        "endpoints": ["chat.completions"],
        "default": true
      }
    ]
  },
  {
    "type": "openai_compatible",
    "id": "glm",
    "provider": "zai",
    "baseUrl": "https://provider.example/v1",
    "apiKeyEnv": "TAKOSUMI_AI_GATEWAY_ZAI_API_KEY",
    "models": [
      {
        "publicModel": "zai/glm",
        "upstreamModel": "glm-provider-model",
        "endpoints": ["chat.completions"]
      }
    ]
  },
  {
    "type": "openai_compatible",
    "id": "gemini-compatible",
    "provider": "gemini",
    "baseUrl": "https://provider.example/v1",
    "apiKeyEnv": "TAKOSUMI_AI_GATEWAY_GEMINI_API_KEY",
    "apiKeyHeader": "x-api-key",
    "models": [
      {
        "publicModel": "gemini/chat",
        "upstreamModel": "gemini-provider-model",
        "endpoints": ["chat.completions", "embeddings"]
      }
    ]
  }
]
```

Rules:

- `type` defaults to `openai_compatible` for existing profiles.
- `openai_compatible` profiles must set `baseUrl` and `apiKeyEnv`.
- Cloudflare Unified Billing uses `type: "openai_compatible"`,
  `baseUrl: "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1"`,
  `apiKeyEnv: "CLOUDFLARE_API_TOKEN"`, and Cloudflare model ids such as
  `openai/gpt-4.1-mini`, `anthropic/claude-sonnet-4-5`, or Google AI Studio model ids as `upstreamModel`.
  It does not require provider API keys in Takosumi; the Cloudflare API token authorizes Cloudflare AI Gateway
  and Unified Billing.
- `workers_ai_binding` profiles must not set `baseUrl`, `apiKeyEnv`,
  `apiKeyHeader`, or static `headers`; they run through the Worker `AI`
  binding configured on the closed Cloud handler environment.
- `baseUrl` for `openai_compatible` profiles must be an HTTPS OpenAI-compatible base URL. Local HTTP is rejected unless
  `TAKOSUMI_AI_GATEWAY_ALLOW_LOCAL_HTTP=1` is set for tests.
- Literal local/private/link-local/metadata IP upstreams and reserved internal DNS suffixes such as `.internal`,
  `.local`, `.home.arpa`, and `.lan` are rejected by default. The Worker cannot synchronously prove every public DNS
  hostname's final CNAME/A record at config load time, so operators must keep AI Gateway upstream profiles on known
  public provider hosts or pair custom hostnames with network egress controls. Set
  `TAKOSUMI_AI_GATEWAY_ALLOW_PRIVATE_UPSTREAMS=1` only for private-upstream tests.
- `apiKeyEnv` is required and must resolve to a worker secret/env value.
- raw `apiKey` values are rejected if embedded in `TAKOSUMI_AI_GATEWAY_PROFILES`.
- `apiKeyHeader` defaults to `authorization`, which sends `Authorization: Bearer <key>`.
- static `headers` may be used only for non-secret provider metadata; reserved auth/cookie/host headers and
  secret-bearing names such as `x-api-key` / `*-token` are rejected. Use `apiKeyEnv` + `apiKeyHeader` for upstream keys.
- `models[].metadata` is returned from `/gateway/ai/v1/models`; secret-bearing keys or token-shaped string values are
  rejected. Put only public display/protocol metadata there.
- public model aliases are stable Takosumi-facing names and do not have to equal provider-native model ids.

Cloudflare Unified Billing is the preferred Takosumi Cloud default for
operator-paid external models because Takosumi stores only the Cloudflare API
token and does not hold provider-specific API keys. Direct/BYOK provider
examples such as DeepSeek, Z.AI GLM, Gemini, OpenAI, or any OpenAI-compatible
host also use `type: "openai_compatible"`: configure a profile, map public
aliases to upstream model ids, and keep the upstream key behind `apiKeyEnv`.
Cloudflare Workers AI uses `type: "workers_ai_binding"` when Takosumi Cloud
calls the Worker `AI` binding directly without issuing or storing a REST API
token. Workers AI `@cf/...` models are separate from Cloudflare AI Gateway
Unified Billing and follow Workers AI pricing.

`GET /gateway/ai/v1/__takosumi/status` returns only public readiness
metadata. Explicitly configured profiles report `configured_upstreams`, the
public providers/model aliases, and whether the Cloud handler environment has a
Workers AI binding available for `workers_ai_binding` profiles. It never
returns upstream keys, `apiKeyEnv` names, raw `Authorization` material, or
handler keys. Takosumi Cloud should configure at least one explicit
profile before claiming AI Gateway readiness. Use `type: "openai_compatible"`
with Cloudflare
AI Gateway REST API and Unified Billing for the default operator-paid sandbox,
use direct/BYOK `openai_compatible` profiles when Takosumi intentionally owns
provider-specific keys, or use `type: "workers_ai_binding"` for the base
Cloudflare Workers AI binding. Any launch claim for external upstreams must run
the Takosumi Cloud private `smoke:cloud-extensions` command with
`--require-ai-upstream-profile`.

AI Gateway billing readiness is proven through the usage ledger, not response
headers. The platform strips internal usage headers before returning the
OpenAI-compatible response, so GA smoke should rotate a runtime service token,
call chat/embeddings, then read the target Workspace usage ledger and
confirm a new `source: "resource_meter"` / `kind: "ai_request"` event for the
same Workspace and service resource. Use `--require-ai-runtime-service-token
--ai-service-resource-id <id> --require-ai-usage-ledger
--ai-usage-workspace-id <workspace-id>` for that strict check.

## Secret Boundary

There are two different keys:

| key                                   | holder                       | purpose                                             |
| ------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Cloudflare AI Gateway API token       | operator platform worker env | authorizes Cloudflare Unified Billing REST profiles |
| direct/BYOK upstream provider API key | operator platform worker env | authorizes Takosumi to call a provider directly     |
| Runtime service token                 | Capsule runtime projection   | authorizes that runtime to call the gateway         |

The Capsule runtime never receives the Cloudflare API token or a direct upstream provider key. It receives only the
rotated runtime service token and the gateway base URL. The gateway injects the operator-held credential at request time
and strips hop-by-hop or unsafe response headers before returning the upstream response.

## Failure Model

- Cloud extension not mounted on the platform worker: `404 { "error": "not found" }`
- invalid gateway config: `500 gateway_misconfigured`
- missing or stale runtime service token: `401 invalid_token`
- missing endpoint scope: `403 insufficient_scope`
- unknown model or wrong endpoint for a model alias: `404 model_not_found`
- upstream network failure: `502 upstream_unavailable`
- upstream HTTP error: same upstream status with `upstream_error`; the upstream response body is not passed through

Errors returned by the Cloud extension use an OpenAI-style JSON shape:

```json
{
  "error": {
    "message": "insufficient scope",
    "type": "invalid_request_error",
    "code": "insufficient_scope"
  }
}
```
