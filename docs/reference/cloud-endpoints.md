# Takosumi Cloud endpoints

Takosumi Cloud endpoints は Takosumi Cloud 専用の managed service です。
Takosumi OSS / Takosumi for Operators の public contract には含めません。

アプリ画面の役割は、日常的に見る運用情報をすぐ確認できるようにすることです。
API key、接続状態、今月の使用量、残高、作成済みリソース数を優先して表示します。
仕様、対象範囲、endpoint の契約はこのページに集約します。

## 画面と docs の分担

`app.takosumi.com/cloud` は API key とリソースの管理に絞った画面です。

- API key の作成、一覧、失効
- Cloud リソース (KV / Object Storage / Database / Worker) の一覧、ID コピー、削除
- AI Gateway の Base URL、接続状態、既定モデル
- Cloudflare Compatibility API の Base URL と現在の account

使用量と請求は Cloud 画面ではなく支払い (`app.takosumi.com/billing`) に置きます。

- 今月の使用量、Gateway 使用量、利用可能クレジット
- 使用履歴 (usage event の台帳)

リソースの削除は compat gateway の DELETE を呼びます。`write` scope の session が
必要で、Cloud backend が materialize 済みのときだけ反映され、未対応環境では gateway
が 501 を fail-closed で返します。画面には全仕様を置きません。provider 互換の
対応範囲、OpenTofu provider 設定例、usage event の contract、secret の扱いは docs
側で確認します。

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
- `ai_request`
- `ai_input_token`
- `ai_output_token`
- `runner_minute`
- `operation`
- `artifact_storage_gb_hour`
- `backup_storage_gb_hour`
- `egress_gb`

usage event は quantity、credits、source、timestamp を持ちます。provider
credential、API key、bearer token、database URL、DSN、password などの secret
値を持ってはいけません。

Cloud extension は、実行結果に内部 usage report header を付けることで
platform worker に使用量を報告できます。platform worker はこの header を
client response から削除し、`recordGatewayResourceUsage` で Workspace usage
ledger に記録します。usage report があるのに ledger へ記録できない場合は、
未課金の成功を返さないため fail closed します。

内部 header:

```http
x-takosumi-cloud-usage-space-id: space_xxx
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T13:01:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"ai:default:request","kind":"ai_request","quantity":1,"credits":2}]
```

Cloudflare Compatibility Gateway / managed resource backend は、ユーザー向けには
Cloudflare provider の `cloudflare_workers_script` / route / KV / R2 / D1 /
Workflows / Containers などとして見せます。Workers for Platforms は内部 backend
であり、請求・画面・usage ledger の user-facing family には出しません。Worker
script の使用量は `resourceFamily: "cloudflare.workers_script"` として
`gateway_compute` または `gateway_storage_gb_hour` を報告します。`wfp` /
`workers_for_platforms` は `meterId`、`resourceFamily`、Stripe meter では拒否し、
内部実装の証跡として `resourceMetadata.backend` にだけ残せます。例:

```http
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:workers_script:request","resourceFamily":"cloudflare.workers_script","resourceId":"script:api","operation":"request","resourceMetadata":{"backend":"cloudflare.workers_for_platforms"},"kind":"gateway_compute","quantity":1,"credits":1,"installationId":"inst_xxx"}]
```

この ledger に入った使用量を、billing reconciliation / Stripe invoice 側の
正本入力にします。Cloudflare AI Gateway / Workers AI の上流請求は operator の
Cloudflare account に来ますが、それだけでは Takosumi ユーザーへの請求完了を
意味しません。Takosumi 側で請求できていると言える条件は、Cloud extension が
usage report を出し、Workspace usage ledger に記録され、billing/Stripe 側で
集計・請求されることです。

Stripe 連携では、billing account ごとの未 export usage report を meter / unit
単位で rollup し、Stripe invoice item として作成します。成功した usage report
には `billingExportProvider: "stripe"`、export id、Stripe invoice item id、
exported timestamp を保存し、同じ report を次回同期で再請求しません。例えば
Cloudflare Workers compat の請求名は `cloudflare.workers_script` のままで、
`wfp` / `workers_for_platforms` を請求名にしてはいけません。
`resourceMetadata.backend: "cloudflare.workers_for_platforms"` は内部実装の証跡に
留めます。

operator が Stripe usage invoice item 同期を起動する route は account plane の
`POST /v1/billing/stripe/usage-invoice-items` です。これは customer API ではなく
operator-only route で、`x-takosumi-billing-usage-sync-token` が必要です。
body に `usageEvents` を渡すと、route は ready な Installation projection の
`billingAccountId` を使って `BillingUsageRecord` に import してから Stripe invoice
item を作ります。これにより、Cloud extension usage ledger から Stripe 請求までの
経路が途切れません。
`TAKOSUMI_STRIPE_USAGE_INVOICE_ITEM_PRICES` には meter / unit / unitAmount /
currency の JSON 配列を設定します。例:

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
- Cloudflare billing API
- registrar
- load balancer
- email routing
- Turnstile

Cloudflare billing API は互換対象外です。一方で Takosumi Cloud が提供する
managed resources の使用量は Cloudflare billing API ではなく、上記の
Workspace usage ledger へ記録する必要があります。

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
