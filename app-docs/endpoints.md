# Takosumi Cloud endpoints

このページは `app.takosumi.com` が公開する Takosumi Cloud endpoint family の
契約です。Takosumi OSS / Takosumi for Operator の portable API とは分けて
扱います。

Cloud の公開説明は [Takosumi Cloud](./index.md) と
[Takosumi Cloud resources](./resources.md) を正本にします。このページは
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

リソースの削除は共通 Cloud managed-resource operation boundary に delete action を
送ります。Cloudflare-shaped import path で作られた resource は compatible import
endpoint の DELETE でも削除できます。`write` scope の session が必要で、Cloud
managed resource が作成済みのときだけ反映されます。未対応の endpoint family は 501
を fail-closed で返します。画面には全仕様を置きません。provider 互換の対応範囲、
OpenTofu provider 設定例、usage event の contract、secret の扱いは docs 側で確認します。

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

公式 `app.takosumi.com` は Cloud endpoint family を同じ hosted platform origin で
提供します。AI Gateway、Cloudflare-compatible import endpoint、
S3-compatible Object Storage endpoint、Cloud usage、Cloud Edge Runtime は
Takosumi Cloud の managed backend で処理されます。managed backend の内部実装、
secret、operator-only records は公開 contract ではなく、operator runbook 側で
管理します。

## Catalog

Cloud endpoint の有効状態はこの route で確認できます。
Dashboard からは account session cookie で読みます。automation では適切な
read scope を持つ service token で読めます。

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
この catalog は公開 endpoint と capability だけを列挙します。
`authMode: "handler"` は、S3 SigV4 のように endpoint family 自体が標準署名を
検証する catalog value です。この場合 platform session / PAT ではなく protocol
署名を検証し、spoof 可能な Takosumi context header と cookie は削除します。
`*.app.takos.jp` / `*.app-staging.takos.jp` の Takosumi Cloud public HTTP traffic は
同じ hosted origin の hostname dispatch registry で Cloud runtime に送られます。

## API key / owner billing context

`takosumi` provider が使う Resource Shape API (`/v1/resources` /
`/v1/target-pools` / `/v1/space-policies`) と Cloudflare-compatible import
endpoint (`/compat/cloudflare/client/v4`) は、Capsule / app installation 登録がなくても使えます。
ただし匿名では使えません。account session、personal access token、または service token
で認証し、発生元 Workspace と所有ユーザーの課金アカウントを検証できる必要があります。

session / personal access token は `x-takosumi-cloud-billing-workspace-id` で
発生元 Workspace を指定できます。platform はその token が Workspace を読めることを accounts
plane で確認してから、所有ユーザーの billing account / credit balance を解決し、対象の Cloud
endpoint family または Resource Shape API へ転送します。
Cloudflare provider など任意 header を付けにくい OpenTofu provider で使う API key は、
作成時に `workspace_id` を指定した personal access token にします。この場合 platform は
token introspection の `takosumi.space_id` を default source Workspace として使い、
provider config は `api_token` と `base_url` だけで動きます。service token は token metadata
に紐づく Workspace だけを使えます。

Takosumi Cloud が提供する managed compatibility target を OpenTofu から使う場合は、
その Workspace-bound token を generic-env ProviderConnection に保存し、runner env として
`CLOUDFLARE_API_TOKEN` へ注入します。plain OpenTofu stack で既存 Cloudflare provider
manifest を import / deploy path として使う場合は、provider config の `base_url` に
Takosumi Cloud の compat endpoint を指定します。Resource Shape の TargetPool で
`providerBaseUrl` を持てるのは、operator が allowlist した URL かつ
operator-installed `plugin` implementation に限ります。
生成される provider block は `base_url` だけを持ち、secret は HCL / plan / state に残りません。
本物の Cloudflare account へ出す target では、通常どおりユーザーの Cloudflare ProviderConnection
を使います。

billable な write は転送前に所有ユーザーの account credits から precharge されます。Workspace context
がない、token と Workspace が一致しない、または所有ユーザーの credits が足りない場合は fail closed
し、Cloud endpoint / apply path へは進みません。Capsule / installation id は任意です。未指定の
provider / compatibility API 使用量は、`installationId` なしの owner account usage event として
記録され、発生元 Workspace は metadata に残ります。

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
紐づき、bucket descriptor は Takosumi Cloud の managed-resource inventory から供給します。

`GET /compat/s3/v1/__takosumi/status` は SigV4 なしで読める運用状態です。Dashboard
はこの status で configured bucket 数を表示します。

write/read/list 操作は Cloud usage ledger に事前課金します。所有ユーザーの USD balance が
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
  "scopes": ["read", "write"],
  "workspace_id": "space_xxx"
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

Cloud managed endpoints は使用量を owner account usage ledger に記録し、発生元
Workspace を attribution metadata として残します。ledger
に記録できない成功は返しません。残高不足、Workspace context 不足、未価格付け、
scope 不一致では、下流 provider、AI upstream、runtime dispatch へ進まず fail
closed します。

価格は Cloud endpoint request body ではなく Takosumi Cloud 側で決めます。request
body や client header に `usdMicros` / `credits` を書かせません。公開価格と無料枠は
[Takosumi Cloud pricing](./pricing.md) と Dashboard の billing 表示に出します。
実際の price book、同期手順、payment provider 連携の運用 detail は公開 reference
ではなく運用メモ側で管理します。

cleanup は拡張と分けます。作成、deploy、runtime、data-plane write/query/message
/ instance operation は billable で、credit が足りない場合は fail closed します。
一方で DELETE cleanup は、残高切れで user data や managed resource が取り残されない
よう、原則として fallback usage を持たせません。

Takosumi Cloud の managed resource backend は、Cloudflare-oriented OpenTofu
manifest には `cloudflare_workers_script` / route / KV / R2 / D1 / Queues /
Workflows の Cloudflare-shaped compatibility view として見せられます。一方で UI、
billing、usage ledger、public resource identity では `EdgeWorker`、`ObjectBucket`、
`KVStore`、`SQLDatabase`、`Queue` などの service form を使います。内部 backend 名は
請求・画面・usage ledger の user-facing family には出しません。Unsupported managed
subpath は 501 で閉じ、Cloudflare upstream へ素通しして無料利用できる状態にはしません。

Takosumi 側で請求できていると言える条件は、owner account usage ledger に usage event
が記録され、billing projection へ反映されることです。上流 provider の請求だけでは
Takosumi ユーザーへの請求完了を意味しません。payment provider への export、
reconciliation、price book の実値は customer API ではなく operator runbook の範囲です。

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

Takosumi Cloud の公式 managed target では、この endpoint は operator allowlist 済みの
compat URL として扱います。`EdgeWorker` だけでなく、R2/KV/D1/Queue 相当の
managed bindings も同じ compat endpoint を使う場合は、各 implementation に同じ
`providerBaseUrl` と operator-installed `plugin` を設定します。例:

```json
{
  "plugin": "takosumi-cloud-managed",
  "providerBaseUrl": "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

公式 managed target では、typed `takosumi_*` Resource Shape がこの TargetPool
implementation を選ぶと、Takosumi Cloud の managed-resource adapter へ直接
dispatch されます。この場合も入口は Resource Shape API のままで、
TargetPool / Policy / ResolutionLock を通り、Cloud extension 共通層の usage /
credit guard を通ります。Cloudflare 実装は
内部でこの compat handler を再利用するため、EdgeWorker は Workers for Platforms
dispatch namespace に、ObjectBucket / KVStore / SQLDatabase / Queue は選択された
managed backend primitive に落ちます。

`takosumi_edge_worker` と Cloudflare provider compatibility path は同じ Cloud
managed-resource operation boundary を通ります。Resource Shape entrypoint は
TargetPool / Policy / ResolutionLock / Adapter dispatch を使い、compatibility
entrypoint は Cloud extension catalog / auth / usage guard と compat manager の
virtual resource ledger を使います。どちらも backend API を叩く前に Workspace
context と owner account credits を検証し、裏側の実装は manager が決めます。managed
compatibility target の credential は provider-native env delivery で渡されるため、
Cloudflare provider は
`CLOUDFLARE_API_TOKEN=<Workspace-bound Takosumi token>` と `base_url` だけで
Takosumi Cloud の compat endpoint を叩きます。Takosumi Cloud の初期 Worker
implementation は Workers for Platforms の dispatch namespace を使いますが、
それは `EdgeWorker` 実装の一候補であり、public API や provider schema には固定
しません。

Cloud managed resource の入口は、Compatibility API、既存 OpenTofu provider、
`takosumi/takosumi` provider の Resource Shape API のどれでも同じ扱いです。
入口ごとの差は request shape と ownership ledger です。auth、capability、
owner account usage / credit guard、Resource / NativeResource 正規化、manager dispatch
は共通に通します。Resource Shape entrypoint では TargetPool / Policy /
ResolutionLock が追加で適用されます。
Cloudflare-compatible endpoint は独立した別 stack ではなく、この共通 Cloud managed
operation boundary への import / deploy path です。
Cloud resource の正本名は `EdgeWorker` / `ObjectBucket` などの service form と
`takosumi.edge_worker` などの service family です。`cloudflare.workers_script` や
`cloudflare.r2` は billing / compat meter の公開分類、Workers for Platforms や R2
は selected manager / backend 実装です。

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
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts/{scriptName}/subdomain
GET /compat/cloudflare/client/v4/accounts/{accountId}/storage/kv/namespaces
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
GET /compat/cloudflare/client/v4/accounts/{accountId}/d1/database
```

初期 target は Workers 系 subset に限定します。

- Workers scripts
- Workers routes
- Workers script subdomain compatibility mapped to `*.app.takos.jp`
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
owner account usage ledger へ記録する必要があります。

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
Takosumi が `<app-slug>-<short-id>.<managed-base-domain>` を発行します。
Takosumi Cloud の既定 managed base domain は `app.takos.jp` です。operator は
同じ contract で別の managed base domain を設定できます。
managed namespace は first-come-first-served で、重複時は 409 を返します。
409 response は claimant の Workspace / Capsule 名を公開しません。
managed namespace は custom domain quota とは別枠です。`*.app.takos.jp`
のような operator-owned base domain 配下の定型 hostname は、重複排他・禁止語・
abuse rate limit で守り、通常のインストールでは広く使える前提にします。
`custom_domains` はユーザー所有ドメインです。DNS ownership verification、
certificate provisioning、runtime dispatch の有効化、plan/quota/abuse policy は
Cloud runtime 側の責務です。
任意の apex / subdomain は verified domain として owner account に紐づけ、
plan/quota/abuse policy で数と利用を制限します。
未検証 custom domain は runtime で有効化せず、default hostname は維持します。

`cloudflare_workers_script_subdomain` 互換 route は、Cloudflare の
`workers.dev` ではなく Takosumi managed `*.app.takos.jp` 公開名として保存されます。
`POST /accounts/{accountId}/workers/scripts/{scriptName}/subdomain` with
`{"enabled": true, "previews_enabled": false}` は
`<script-slug>-<short-id>.app.takos.jp/*` の virtual Workers route を作成します。
`previews_enabled: true` は初期 target 外です。

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

この inventory は運用確認用です。lifecycle の入口は、Compatibility API、
Cloudflare-compatible OpenTofu provider、`takosumi/takosumi` provider の
Resource Shape API、Dashboard action のどれでも構いません。いずれも共通 Cloud
managed-resource operation boundary に正規化されます。`resource_shapes`
capability は typed Resource Shape API が使えることを示すもので、別の managed
resource lifecycle を意味しません。

## Security contract

Cloud endpoint の contract では次を守ります。

- secret value は作成時以外に再表示しない
- usage / catalog / status / model metadata に secret-shaped value を入れない
- platform worker は API key / session の有効性と read/write scope を検証する
- Cloud endpoint は Workspace / account / virtual account の resource scope を検証する
- unsupported route は互換っぽく成功させず fail closed する
- OSS Takosumi に Cloud-only backend を持ち込まない

## Availability

Cloud endpoint availability is advertised through the catalog and capability
matrix. If an endpoint family is not configured, the route must fail closed
instead of silently falling back to an unmanaged upstream or returning a fake
success.
