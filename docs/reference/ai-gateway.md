# AI Gateway

Takosumi AI Gateway is a **Takosumi Cloud / closed operator extension**, not a
Takosumi OSS control-plane feature. OSS Takosumi remains an OpenTofu/Terraform
control plane that runs existing providers as-is; it does not provide model
gateway services as part of the public OSS contract.

The Cloud extension is an operator-backed, OpenAI-compatible service projected
through Service Graph. It lets an installed service use one Takosumi endpoint
and one rotated Service Graph service token while the operator keeps upstream
provider keys in platform secrets. OSS code may carry the fail-closed route seam
so the shared platform worker can be composed and tested, but enabling upstream
profiles and provider keys belongs to the closed Takosumi Cloud/operator
deployment.

It is not an OpenTofu provider credential and it is not an OpenTofu output secret. OpenTofu provisions and deploys the
service that will consume the model API; runtime model access is granted after deployment through
`takosumi.ai.gateway`.

## Cloud Extension Contract

Service Graph projection:

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
| `POST /gateway/ai/v1/chat/completions` | `ai.chat`        | forwards chat completions to an upstream |
| `POST /gateway/ai/v1/embeddings`       | `ai.embeddings`  | forwards embeddings to an upstream       |

The request bearer must be a current `takosumi.ai.gateway` Service Graph service token for the Installation. Tokens
are rotated through the existing installation service route:

```http
POST /v1/installation-projections/{installationId}/services/takosumi.ai.gateway/rotate-token
```

Body:

```json
{
  "scopes": ["ai.models.read", "ai.chat", "ai.embeddings"]
}
```

If `scopes` is omitted, the gateway token receives all three endpoint scopes. A narrower token can be issued for a
service that only needs model listing or chat completions.

## Operator Configuration

The platform worker reads upstream profiles from `TAKOSUMI_AI_GATEWAY_PROFILES`. This is config, not a secret. Each
profile names the env/secret that contains the upstream key.

```json
[
  {
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

- `baseUrl` must be an HTTPS OpenAI-compatible base URL. Local HTTP is rejected unless
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

Provider examples such as DeepSeek, Z.AI GLM, Gemini, OpenAI, Workers AI, or any OpenAI-compatible host are all the
same gateway mechanism: configure a profile, map public aliases to upstream model ids, and keep the upstream key behind
`apiKeyEnv`.

## Secret Boundary

There are two different keys:

| key                         | holder                       | purpose                                      |
| --------------------------- | ---------------------------- | -------------------------------------------- |
| upstream provider API key   | operator platform worker env | authorizes Takosumi to call the provider     |
| Service Graph service token | installed service runtime    | authorizes that Installation to call gateway |

The installed service never receives the upstream provider key. It receives only the rotated Service Graph token and
the gateway base URL. The gateway injects the upstream provider key at request time and strips hop-by-hop or unsafe
response headers before returning the upstream response.

## Failure Model

- missing or invalid gateway config: `503 ai_gateway_not_configured`
- missing or stale Service Graph token: `401 invalid_token`
- missing endpoint scope: `403 insufficient_scope`
- unknown model or wrong endpoint for a model alias: `404 model_not_found`
- upstream network failure: `502 upstream_unavailable`
- upstream HTTP error: same upstream status with `upstream_error`; the upstream response body is not passed through

All errors use an OpenAI-style JSON shape:

```json
{
  "error": {
    "message": "insufficient scope",
    "type": "invalid_request_error",
    "code": "insufficient_scope"
  }
}
```
