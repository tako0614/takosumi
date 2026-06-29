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

- 今月の使用量、Cloud リソース使用量、利用可能残高
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

| 表示                 | 読み方                                             |
| -------------------- | -------------------------------------------------- |
| 今月の使用量         | 今月発生した usage event の `usdMicros` 合計       |
| Cloud リソース使用量 | `gateway_` で始まる kind の `usdMicros` 合計       |
| 利用可能残高         | billing projection の `balance.availableUsdMicros` |
| 最近の使用量         | `createdAt` が新しい usage event                   |

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

usage event は quantity、usdMicros、source、timestamp を持ちます。provider
credential、API key、bearer token、database URL、DSN、password などの secret
値を持ってはいけません。

Cloud extension は、実行結果に内部 usage report header を付けることで
platform worker に使用量を報告できます。platform worker はこの header を
client response から削除し、`recordGatewayResourceUsage` で Workspace usage
ledger に記録します。usage report があるのに ledger へ記録できない場合は、
未課金の成功を返さないため fail closed します。

state-changing Cloud extension route が `TAKOSUMI_CLOUD_EXTENSIONS` の
`fallbackUsage` に一致する場合、platform worker は bound Cloud worker を呼ぶ前に
price book で `usdMicros` を確定し、Workspace balance から atomic に spend します。
残高不足・未価格付け・billing Workspace context 不足では upstream Cloudflare API /
AI upstream / dispatch は呼びません。extension response が同じ request meter を
返した場合は二重記録せず、AI の input/output token など response 後にしか分からない
追加 meter だけを後段で記録します。

public traffic を受ける Cloud Edge Runtime は例外で、client response に usage
header を出しません。route ledger に `spaceId` があることを前提に、dispatch 前に
platform worker の内部 route `POST /internal/platform/cloud/usage` へ
`cloudflare:workers_script:request` meter を送り、price book による課金が成功した
場合だけ Workers Script を dispatch します。残高不足・価格未設定・内部 usage token
未設定では Workers Script は実行されません。

価格は Cloud extension ではなく Takosumi Cloud platform worker が決めます。
Cloud extension の usage report は `meterId`、`kind`、`quantity`、resource metadata
を出すのが正本です。`usdMicros` を extension が出す経路は legacy / fallback
互換として残せますが、production では operator config の
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` が単価・原価見積もり・最低粗利を検証して
`usdMicros` を確定します。price book に meter がない、または最低粗利を満たさない
meter は fail closed し、WfP / AI の未課金成功を返しません。価格表と無料枠の
運用正本は `docs/operations/cloud-pricing.md` です。

内部 header:

```http
x-takosumi-cloud-usage-space-id: space_xxx
x-takosumi-cloud-usage-period-start: 2026-06-26T13:00:00.000Z
x-takosumi-cloud-usage-period-end: 2026-06-26T13:01:00.000Z
x-takosumi-cloud-usage-meters: [{"meterId":"ai:default:request","kind":"ai_request","quantity":1}]
```

Takosumi Cloud の managed resource backend は、ユーザー向けには Cloudflare
provider の `cloudflare_workers_script` / route / KV / R2 / D1 / Queues /
Workflows として見せます。内部 backend 名は請求・画面・usage ledger の
user-facing family には出しません。
Worker script の使用量は `resourceFamily: "cloudflare.workers_script"` として
`gateway_compute` または `gateway_storage_gb_hour` を報告します。Queues は
`cloudflare.queues`、Workflows は `cloudflare.workflows` として報告します。
KV value、R2 object、D1 query、Queue message、Workflow instance などの
data-plane subpath は、対応 meter と fail-closed smoke が揃うまで 501 で閉じます。
未実装 data-plane を Cloudflare upstream へ素通しして無料利用できる状態にはしません。
Containers / Durable Objects などの追加 family は、closed Gateway backend
が lifecycle endpoint と usage smoke を通した後に catalog / 画面 / billing price
へ追加します。内部 backend alias は `meterId`、`resourceFamily`、Stripe meter、
public usage metadata では拒否します。例:

```http
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:workers_script:request","resourceFamily":"cloudflare.workers_script","resourceId":"script:api","operation":"request","kind":"gateway_compute","quantity":1,"installationId":"inst_xxx"}]
```

storage-backed resource の在庫計測では、closed `takosumi-cloud` の
`storageInventoryUsageReports()` helper が provider inventory collector の
平均 bytes と実 period から GB-hour を計算し、同じ header 形式で報告します。

collector は customer API ではなく Cloud-only extension endpoint を呼びます。
platform 側の `TAKOSUMI_CLOUD_EXTENSIONS` では `/cloud/usage` を closed
`takosumi-cloud-usage` service binding に向け、service token には usage 書き込み用
scope を付けます。request は 1 Workspace ずつ batch し、複数 Workspace を混ぜると
endpoint は 400 を返します。verified billing Workspace context と sample の
`workspaceId` が一致しない場合も 403 で fail closed します。

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

この ledger に入った使用量を、billing reconciliation / Stripe invoice 側の
正本入力にします。Cloudflare AI Gateway / Workers AI の上流請求は operator の
Cloudflare account に来ますが、それだけでは Takosumi ユーザーへの請求完了を
意味しません。Takosumi 側で請求できていると言える条件は、Cloud extension が
usage report を出し、Workspace usage ledger に記録され、billing/Stripe 側で
集計・請求されることです。

Cloud extension が正確な usage header を返すのが正本です。ただし header 未配線の
成功リクエストを無料成功にしないため、platform worker は検証済みの billing
Workspace context がある場合に限って最低限の operation usage を fallback 記録します。
この fallback は精密な token / storage 使用量ではなく、課金漏れ防止用の
operation metering です。Cloudflare Workers compat の fallback も
`cloudflare.workers_script` として記録し、内部 backend 名は usage event へ
残しません。

Stripe 連携では、billing account ごとの未 export usage report を meter / unit
単位で rollup し、Stripe invoice item として作成します。成功した usage report
には `billingExportProvider: "stripe"`、export id、Stripe invoice item id、
exported timestamp を保存し、同じ report を次回同期で再請求しません。例えば
Cloudflare Workers compat の請求名は `cloudflare.workers_script` のままで、
内部 backend alias を請求名にしてはいけません。`resourceMetadata.backend` の
ような内部実装 hint も public usage / billing payload には入れません。

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
