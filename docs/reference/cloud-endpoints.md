# Takosumi Cloud endpoints

Takosumi Cloud endpoints は Takosumi Cloud 専用の route / handler と
managed-resource backend です。Takosumi OSS / Takosumi for Operator の
public contract には含めません。

Cloud の公開説明は [Takosumi Cloud](../cloud/index.md) と
[Takosumi Cloud resources](./cloud-resources.md) を正本にします。このページは
endpoint、usage、API key、互換 route の契約を確認する詳細 reference です。

アプリ画面の役割は、日常的に見る運用情報をすぐ確認できるようにすることです。
API key、接続状態、今月の使用量、残高、作成済みリソース数を優先して表示します。
仕様、対象範囲、endpoint の契約はこのページに集約します。

## 画面と docs の分担

`app.takosumi.com/cloud` は API key とリソースの管理に絞った画面です。

- API key の作成、一覧、失効
- Cloud リソース (KV / Object Storage / Database / Worker) の一覧、ID コピー、削除
- AI Gateway の Base URL、接続状態、既定モデル
- OpenTofu import endpoint の Base URL と現在の virtual account
- Object Storage endpoint の Base URL と S3-compatible bucket 設定状態

使用量と請求は Cloud 画面ではなく支払い (`app.takosumi.com/billing`) に置きます。

- 今月の使用量、Cloud リソース使用量、利用可能残高
- 使用履歴 (usage event の台帳)

リソースの削除は compatible import endpoint の DELETE を呼びます。`write` scope の session が
必要で、Cloud backend が materialize 済みのときだけ反映され、未対応環境では endpoint
が 501 を fail-closed で返します。画面には全仕様を置きません。provider 互換の
対応範囲、OpenTofu provider 設定例、usage event の contract、secret の扱いは docs
側で確認します。

## 境界

Takosumi OSS は Git-based OpenTofu control plane、Resource Shape API、
Compatibility API framework、Adapter system を持ちます。

Takosumi for Operator / Cloud の運用層だけが次を持ちます。

- AI Gateway
- Takosumi Cloud resources
- official hosted Cloudflare-compatible import endpoint backend
- official S3-compatible Object Storage endpoint backend
- official managed target / native resource backend
- official usage / quota / billing / support controls

公式 `app.takosumi.com` は closed `takosumi-cloud/platform/worker.ts` wrapper を
Worker entry にし、OSS platform worker の `cloud_extensions` seam に Cloud-only
fetch handler を in-process で mount します。AI Gateway、Cloudflare-compatible
import endpoint、S3-compatible Object Storage endpoint、Cloud usage、Cloud Edge
Runtime の実装は closed handler 側にあり、OSS code に入れてよいのは catalog
metadata、auth forwarding、dashboard client、smoke test までです。`handlerKey`
は OSS seam が参照する論理 handler key であり、公式 Cloud wrapper が in-process
で解決します。これは単一の `takosumi-cloud/platform/worker.ts` deployment unit
であり、AI Gateway / Cloudflare-compatible import endpoint /
S3-compatible Object Storage endpoint / Cloud usage / Cloud Edge Runtime を別
Worker として deploy しません。managed resource backend は Takosumi Cloud 側の
closed module です。

## Catalog

Cloud extension の有効状態はこの route で確認できます。
Dashboard からは account session cookie で読みます。operator drill /
automation では deploy-control bearer でも読めます。

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

`configured: false` の extension は画面に出ても、実行時は fail closed します。
この catalog は path-based の `cloud_extensions` route だけを列挙します。
`authMode: "handler"` は、S3 SigV4 のような標準プロトコル署名を Cloud handler
が直接検証する route だけに使います。この場合 platform は customer session /
PAT を検証せず、spoof 可能な Takosumi context header と cookie は削除し、
`Authorization` header を handler に渡します。
`*.app.takos.jp` / `*.app-staging.takos.jp` の Takosumi Cloud public HTTP traffic は
同じ `takosumi-cloud/platform/worker.ts` 内の hostname dispatch registry で
Cloud runtime に送られます。別 Worker ではありません。

## S3-compatible Object Storage endpoint

S3-compatible endpoint は、Takosumi Cloud が提供する Object Storage を既存 S3
SDK / S3-compatible OpenTofu provider から利用するための data-plane です。AWS API
完全互換ではありません。公開範囲は `compat.s3.v1` capability として明示します。

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

通常の Cloud API key (Takosumi Accounts personal access token) は S3 SDK の
credential ではありません。S3-compatible endpoint は AWS SigV4 形式の access
key / secret access key を検証します。access key は Workspace と許可 bucket に
紐づき、bucket descriptor は Cloud 側の realized config / managed-resource backend
から供給します。

`GET /compat/s3/v1/__takosumi/status` は SigV4 なしで読める運用状態です。Dashboard
はこの status で configured bucket 数を表示します。

write/read/list 操作は Cloud usage ledger に事前課金します。Workspace USD balance が
不足している場合、`PUT` は backend 書き込み前に `402 PaymentRequired` で止まります。
`DELETE` cleanup は残高不足でも詰まらないよう、操作課金を持たせません。

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
`fallbackUsage` に一致する場合、platform worker は mounted Cloud extension handler を呼ぶ前に
price book で `usdMicros` を確定し、Workspace balance から atomic に spend します。
残高不足・未価格付け・billing Workspace context 不足では upstream Cloudflare API /
AI upstream / dispatch は呼びません。extension response が同じ request meter を
返した場合は二重記録せず、AI の input/output token など response 後にしか分からない
追加 meter だけを後段で記録します。

public traffic を受ける Cloud Edge Runtime は使用量報告だけが例外で、client
response に usage header を出しません。ただし Edge Runtime handler も同じ公式
platform Worker に mount されます。route ledger に `spaceId` があることを前提に、
dispatch 前に platform worker の内部 route `POST /internal/platform/cloud/usage` へ
`cloudflare:workers_script:request` meter を送り、price book による課金が成功した
場合だけ Workers Script を dispatch します。残高不足・価格未設定・内部 usage token
未設定では Workers Script は実行されません。

価格は Cloud extension ではなく Takosumi Cloud platform worker が決めます。
Cloud extension の usage report は `meterId`、`kind`、`quantity`、resource metadata
だけを出します。価格は operator config の `TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` が
単価・原価見積もり・最低粗利を検証して確定します。extension request body や header
には `usdMicros` / `credits` を書かせません。price book に meter がない、または
最低粗利を満たさない meter は fail closed し、WfP / AI の未課金成功を返しません。
価格表と無料枠の運用正本は `docs/operations/cloud-pricing.md` です。

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
KV value、R2 object、D1 query、Queue message、Queue consumer、Workflow
instance の subpath は、対応する public meter と platform `fallbackUsage`
precharge がある場合だけ開きます。R2 は bucket lifecycle、object read/write、
storage inventory を課金対象にします。R2 object DELETE は cleanup として扱い、
残高切れで user data が取り残されないよう fallback usage meter を出しません。
未対応 managed subpath は 501 で閉じ、Cloudflare upstream へ素通しして無料利用
できる状態にはしません。
Containers / Durable Objects などの追加 family は、closed backend が発生させた
usage を `/cloud/usage/resource-meters` で課金 ledger に流せます。ただし、
customer-facing managed resource として catalog / 画面に出すには、別途 lifecycle
endpoint、destroy / deprovision proof、runtime guard の smoke が必要です。内部
backend alias は `meterId`、`resourceFamily`、Stripe meter、public usage metadata
では拒否します。例:

```http
x-takosumi-cloud-usage-meters: [{"meterId":"cloudflare:workers_script:request","resourceFamily":"cloudflare.workers_script","resourceId":"EdgeWorker/api","operation":"request","kind":"gateway_compute","quantity":1}]
```

storage-backed resource の在庫計測では、closed `takosumi-cloud` の
`storageInventoryUsageReports()` helper が provider inventory collector の
平均 bytes と実 period から GB-hour を計算し、同じ header 形式で報告します。

collector は customer API ではなく Cloud-only extension endpoint を呼びます。
公式 Cloud wrapper は `/cloud/usage` を closed Cloud usage handler に in-process
mount し、platform 側の `TAKOSUMI_CLOUD_EXTENSIONS` はその handler key を参照します。
公式 `app.takosumi.com` では platform wrapper が Cloud usage handler を同じ
Worker 内で mount します。service token には usage 書き込み用 scope を付けます。request は
1 Workspace ずつ batch し、複数 Workspace を混ぜると endpoint は 400 を返します。
verified billing Workspace context と sample の `workspaceId` が一致しない場合も
403 で fail closed します。

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

managed resource backend が compute / operation 系の使用量を実測できる場合は、
同じ `/cloud/usage` extension の `resource-meters` endpoint に public meter を送ります。
現在受け付ける family は `cloudflare.containers` と
`cloudflare.durable_objects` だけです。endpoint は verified billing Workspace
context を必須にし、body の `workspaceId` と一致しない usage を拒否します。
`usdMicros` / `credits` は request body に書かせず、platform worker の
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` が価格を決めます。

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
body に `usageEvents` を渡すと、route は verified `workspaceId` の BillingAccount を
使って `BillingUsageRecord` に import してから Stripe invoice item を作ります。
これにより、Cloud extension usage ledger から Stripe 請求までの経路が途切れません。
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

## OpenTofu Import Endpoint

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

`compat.cloudflare.workers.v1` の Cloudflare v4-shaped subset です。目的は
`cloudflare/cloudflare` OpenTofu/Terraform provider の `base_url` を変えて、
Workers-oriented resource を Takosumi Cloud `EdgeWorker` / managed bindings に
向けられるようにすることです。これは既存 manifest を取り込むための import /
deploy path であり、Cloudflare API 全体の互換ではありません。

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
- default `*.app.takos.jp` hostname per HTTP route
- user-owned custom domains on HTTP routes
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

Workers route record は次の hostname fields を持ちます。

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

`default_hostname` は即時利用可能な Takosumi managed URL です。
`app_subdomain` / `default_hostname` / `hostname` で指定できます。指定しない場合は
Takosumi が `<app-slug>-<short-id>.app.takos.jp` を発行します。
`*.app.takos.jp` は first-come-first-served で、重複時は 409 を返します。
`custom_domains` はユーザー所有ドメインです。DNS ownership verification、
certificate provisioning、runtime dispatch の有効化は Cloud runtime 側の責務です。
未検証 custom domain は runtime で有効化せず、default hostname は維持します。

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
Compatibility API と、Cloudflare-compatible OpenTofu provider の plan/apply
result を正本にします。`takosumi/takosumi` provider の Resource Shape API
(`/v1/resources/*`) は別系統で、production host が real ResourceShape adapter
と route を mount している場合だけ `resource_shapes` capability として広告します。

## Security contract

Cloud endpoint の contract では次を守ります。

- secret value は作成時以外に再表示しない
- usage / catalog / status / model metadata に secret-shaped value を入れない
- platform worker は API key / session の有効性と read/write scope を検証する
- closed handler は Workspace / account / virtual account の resource scope を検証する
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
Takosumi Cloud handler で、公式 platform worker が in-process で mount します。
AI Gateway / Cloudflare Compatibility handler が未設定の場合、
`/gateway/ai/v1/*` と `/compat/cloudflare/client/v4/*` は platform worker から
意図的に not found を返します。
