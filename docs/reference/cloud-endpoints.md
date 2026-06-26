# Takosumi Cloud endpoints

Takosumi Cloud endpoints は Takosumi Cloud 専用の managed service です。
Takosumi OSS / Takosumi for Operators の public contract には含めません。

アプリ画面の役割は、日常的に見る運用情報をすぐ確認できるようにすることです。
仕様、対象範囲、endpoint の契約はこのページに集約します。

## 画面と docs の分担

`app.takosumi.com/cloud` では次を優先して表示します。

- API key の作成、一覧、失効
- 今月の使用量、Gateway 使用量、利用可能クレジット
- AI Gateway の Base URL、既定モデル、公開 model alias
- Cloudflare Compatibility API の Base URL と現在の account
- Takosumi Cloud 側に存在する KV / Object Storage / Database / Worker

画面には全仕様を置きません。provider 互換の対応範囲、OpenTofu provider
設定例、usage event の contract、secret の扱いは docs 側で確認します。

## 境界

Takosumi OSS は既存の OpenTofu/Terraform provider をそのまま実行する
control plane です。

Takosumi Cloud だけが次を持ちます。

- AI Gateway
- Cloudflare Compatibility API
- managed resource backend
- official usage / quota / billing / support controls

`app.takosumi.com` の platform worker は Cloud-only route family を公開し、
closed service binding に実装を委譲します。OSS code に入れてよいのは
catalog metadata、auth forwarding、dashboard client、smoke test までです。
managed resource backend は Takosumi Cloud 側の closed module です。

## Catalog

Cloud extension の有効状態はこの route で確認できます。

```http
GET /__takosumi/cloud/extensions
```

例:

```json
{
  "kind": "takosumi.platform-cloud-extensions@v1",
  "generatedAt": "2026-06-26T00:00:00.000Z",
  "serviceUrl": "https://app.takosumi.com",
  "extensions": [
    {
      "id": "ai.openai_compatible.v1",
      "kind": "ai_gateway",
      "protocol": "openai-compatible",
      "basePath": "/gateway/ai/v1",
      "configured": true,
      "capabilities": ["chat.completions", "embeddings", "models.list"],
      "smokeChecks": ["GET /models", "POST /chat/completions"]
    },
    {
      "id": "provider.cloudflare.client_v4",
      "kind": "provider_compat",
      "provider": "cloudflare",
      "protocol": "cloudflare-v4",
      "basePath": "/compat/cloudflare/client/v4",
      "configured": true,
      "capabilities": ["workers", "kv", "r2", "d1"],
      "smokeChecks": ["GET /user/tokens/verify", "GET /accounts"]
    }
  ],
  "summary": {
    "total": 2,
    "configured": 2,
    "missing": 0
  }
}
```

`configured: false` の extension は画面に出ても、実行時は fail closed します。

## API keys

Dashboard で作成する Cloud API key は Takosumi Accounts の personal access
token です。作成時に一度だけ secret value を返します。

```http
GET  /v1/account/tokens
POST /v1/account/tokens
POST /v1/account/tokens/{tokenId}/revoke
```

通常の Cloud endpoint 用 key は次の scope で作成します。

```json
{
  "scopes": ["read", "write"]
}
```

`read` は `GET` / `HEAD` / `OPTIONS` に使います。`write` は compatibility
resource の作成、更新、削除などの mutating route に必要です。通常利用で
`admin` は不要です。

list response には secret value を返しません。画面表示・失効操作に使ってよい
metadata は `id`、`name`、`prefix`、`scopes`、`created_at`、`expires_at`、
`revoked_at`、`last_used_at` です。`subject` は所有者検証用の account-plane
metadata で、secret ではありません。

`GET /v1/account/tokens` は `limit` と `cursor` を受け取り、response に
`next_cursor` を返します。画面は最後の page まで読みます。

## Usage

Cloud usage は Workspace 単位の usage event として記録します。

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

画面の Usage card はこの2つを使います。

| 表示               | 読み方                                           |
| ------------------ | ------------------------------------------------ |
| 今月の使用量       | 今月発生した usage event の `credits` 合計       |
| Gateway 使用量     | `gateway_` で始まる kind の `credits` 合計       |
| 利用可能クレジット | billing projection の `balance.availableCredits` |
| 最近の使用量       | `createdAt` が新しい usage event                 |

主な usage kind:

- `gateway_compute`
- `gateway_storage_gb_hour`
- `runner_minute`
- `operation`
- `artifact_storage_gb_hour`
- `backup_storage_gb_hour`
- `egress_gb`

usage event は quantity、credits、source、timestamp を持ちます。provider
credential、API key、bearer token、database URL、DSN、password などの secret
値を持ってはいけません。

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

OpenAI-compatible client からは次のように使えます。

```bash
OPENAI_BASE_URL=https://app.takosumi.com/gateway/ai/v1
OPENAI_API_KEY=takpat_...
OPENAI_MODEL=takosumi/default
```

`takosumi/default` は安定した default alias です。operator はその alias を
Cloudflare AI Gateway / Unified Billing、Workers AI、または別の
OpenAI-compatible upstream に route できます。`/models` と status response は
公開 model alias と readiness metadata だけを返し、upstream key や secret
env 名を返してはいけません。

## Cloudflare Compatibility API

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

Cloudflare v4-compatible subset です。目的は `cloudflare/cloudflare`
OpenTofu/Terraform provider の `base_url` を変えて、Workers-oriented resource
を Takosumi Cloud managed resource に向けられるようにすることです。

response envelope:

```json
{
  "success": true,
  "result": [],
  "errors": [],
  "messages": []
}
```

Dashboard inventory が使う read route:

```http
GET /compat/cloudflare/client/v4/user/tokens/verify
GET /compat/cloudflare/client/v4/accounts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts
GET /compat/cloudflare/client/v4/accounts/{accountId}/storage/kv/namespaces
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
GET /compat/cloudflare/client/v4/accounts/{accountId}/d1/database
```

初期 target は Workers 系 subset に限定します。

- Workers scripts
- Workers routes
- KV namespaces
- R2 buckets
- D1 databases
- Worker vars / secrets / bindings

初期 target ではないもの:

- DNS 全般
- WAF / Rulesets
- Zero Trust
- Account IAM
- billing
- registrar
- load balancer
- email routing
- Turnstile

## OpenTofu provider usage

Cloudflare provider の例:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

同じ Cloudflare Workers-oriented manifest を本物の Cloudflare と Takosumi
Cloud のどちらにも向けられるようにするのが狙いです。切り替えは manifest
ではなく Provider Binding / Provider Connection で行います。manifest に raw
secret を書いてはいけません。

## Cloud resources inventory

Cloud 画面の resource inventory は Compatibility API から読める現在状態の
要約です。少なくとも次の group を表示します。

- KV
- Object Storage
- Database
- Workers

この inventory は運用確認用です。resource の完全な lifecycle contract は
Compatibility API と OpenTofu provider の plan/apply result を正本にします。

## Security contract

Cloud endpoint の contract では次を守ります。

- secret value は作成時以外に再表示しない
- usage / catalog / status / model metadata に secret-shaped value を入れない
- platform worker は API key / session の有効性と read/write scope を検証する
- closed binding は Workspace / account / virtual account の resource scope を検証する
- unsupported route は互換っぽく成功させず fail closed する
- OSS Takosumi に Cloud-only backend を持ち込まない

## 実装状態

OSS repo にあるもの:

- platform route catalog
- same-origin session / PAT / service-token auth forwarding
- AI Gateway OpenAI-compatible handler seam
- dashboard Cloud endpoint client
- smoke tests and provider E2E expectations

Cloudflare Compatibility backend と managed resource materialization は closed
Takosumi Cloud service binding です。AI Gateway / Cloudflare Compatibility
binding が未設定の場合、`/gateway/ai/v1/*` と
`/compat/cloudflare/client/v4/*` は platform worker から意図的に not found を
返します。
