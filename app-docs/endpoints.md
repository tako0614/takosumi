# Takosumi Cloud endpoints

このページは、`app.takosumi.com` が公開する Takosumi Cloud のエンドポイントファミリの
契約です。Takosumi OSS / Takosumi for Operator の移植可能な API とは分けて
扱います。

Cloud 全体の公式な説明は [Takosumi Cloud](./index.md) と
[Takosumi Cloud resources](./resources.md) にあります。このページは、
エンドポイント、使用量、API key の契約を確認するための詳細リファレンスです。

アプリ画面の役割は、日常的に見る運用情報をすぐ確認できるようにすることです。
API key、接続状態、今月の使用量、残高、作成済みリソース数を優先して表示します。
仕様、対象範囲、エンドポイントの契約はこのページに集約します。

## 画面とドキュメントの分担

`app.takosumi.com/cloud` は API key とリソースの管理に絞った画面です。

- API key の作成、一覧、失効
- Cloud リソース (KV / Object Storage / Database / Worker) の一覧、ID コピー、削除
- AI Gateway の Base URL、接続状態、既定モデル
- Object Storage endpoint の Base URL と S3-compatible bucket 設定状態

使用量と請求は Cloud 画面ではなく、請求画面 (`app.takosumi.com/billing`) に置きます。

- 今月の使用量、Cloud リソース使用量、利用可能残高
- 使用履歴 (使用量イベントの記録)

リソースを削除すると、共通の Cloud マネージドリソース操作境界に削除アクションが
送られます。削除には `write` scope のセッションが必要で、Cloud
マネージドリソースが作成済みのときだけ反映されます。未対応のエンドポイントファミリは 501
を返して安全側に停止します。DELETE の後処理は課金対象の fallback 操作ではないため、
所有アカウントの残高が尽きた source Workspace でも、作成済みのマネージドリソースを
destroy・削除できます。画面にはすべての仕様を載せません。OpenTofu provider の設定例、
使用量イベントの契約、シークレットの扱いはドキュメント側で確認してください。

## 境界

Takosumi OSS は Git ベースの OpenTofu コントロールプレーン、Resource Shape API、
Compatibility API フレームワーク、Adapter システムを持ちます。

Takosumi for Operator / Cloud の運用層だけが次を持ちます。

- AI Gateway
- Takosumi Cloud resources
- official S3-compatible Object Storage endpoint backend
- official managed target / native resource backend
- official usage / quota / billing / support controls

公式の `app.takosumi.com` は、Cloud エンドポイントファミリを同じホスト型プラットフォームオリジンで
提供します。AI Gateway、S3-compatible Object Storage エンドポイント、Cloud 使用量、Cloud Edge Runtime は
Takosumi Cloud のマネージドバックエンドで処理されます。マネージドバックエンドの内部実装、
シークレット、operator 専用レコードは公開契約ではなく、operator runbook 側で
管理します。
すべての managed エンドポイントファミリは、backend API を呼び出す前に、同じ Cloud
マネージドオペレーション境界へ正規化されます。`takosumi_*` Resource Shape の呼び出し、
S3-compatible なデータプレーン request、AI
Gateway の request、runtime dispatch、Dashboard action は、どれも対等な入口です。
互いの fallback 層にはなりません。platform はまず public なサービス形態、選択された
manager、使用量メーターを解決します。未対応の path は 501 を返し、認識済みの path でも
manager が利用できない場合は、使用量が課金される前、または provider backend に触れる前に
501 を返します。

## Catalog

Cloud エンドポイントの有効状態は、次の route で確認できます。
Dashboard からはアカウントセッション cookie で読みます。自動化からは、適切な
read scope を持つサービストークンで読めます。

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
    "total": 3,
    "configured": 3,
    "missing": 0
  }
}
```

`configured: false` の拡張は、画面に表示されても実行時には安全側に停止します。
このカタログには、公開エンドポイントと capability だけを列挙します。
`authMode: "handler"` は、S3 SigV4 のようにエンドポイントファミリ自身が標準の署名を
検証することを示すカタログ値です。この場合はプラットフォームセッション / PAT ではなく
プロトコルの署名を検証し、偽装できる Takosumi コンテキストヘッダと cookie は削除します。
`*.app.takos.jp` / `*.app-staging.takos.jp` に向いた Takosumi Cloud のパブリック HTTP トラフィックは、
同じホスト型オリジンのホスト名ディスパッチレジストリを通って Cloud ランタイムに送られます。

## API key / owner billing context

`takosumi` provider が使う Resource Shape API (`/v1/resources` /
`/v1/target-pools` / `/v1/space-policies`) は匿名では使えません。アカウントセッション、
パーソナルアクセストークン、またはサービストークンで認証し、発生元 Workspace と所有ユーザーの
課金アカウントを検証できる必要があります。EdgeWorker route は、同じ Workspace に属する
Ready `EdgeWorker` と呼び出し Principal を検証してから canonical Interface /
InterfaceBinding を変更します。Capsule hostname を作成する endpoint ではありません。

セッションやパーソナルアクセストークンは `x-takosumi-cloud-billing-workspace-id` で
発生元 Workspace を指定できます。プラットフォームはそのトークンが Workspace を読めることを
アカウントプレーンで確認してから、所有ユーザーの課金アカウント / クレジット残高を解決し、対象の Cloud
エンドポイントファミリまたは Resource Shape API へ転送します。
任意ヘッダを付けにくい OpenTofu provider で使う API key は、作成時に `workspace_id` を指定した
パーソナルアクセストークンにします。この場合プラットフォームは token introspection の
`takosumi.space_id` をデフォルトの発生元 Workspace として使います。サービストークンは
トークンメタデータに紐づく Workspace だけを使えます。

OpenTofu provider の credential は、その Workspace の ProviderConnection に保存し、Credential
Recipe に従って runner の env/file へ注入します。Resource Shape の TargetPool で
`providerBaseUrl` を持てるのは、operator が許可リストに入れた URL かつ operator がインストールした
`plugin` 実装に限ります。シークレットは HCL / plan / state に残しません。Cloudflare account へ
出す provider-native target では、通常どおりユーザーの Cloudflare ProviderConnection を使います。

課金対象の Resource 書き込みは `/v1/resources` が versioned offering と PriceCatalog から
immutable quote を作り、reviewed apply で reserve してから backend を呼びます。インストールされた
Compatibility API profile の control request も typed Resource request へ変換され、同じ lifecycle を
通ります。Workspace がない、トークンと Workspace が一致しない、quote が失効・不一致、
残高不足の場合は reserve や backend call の前に安全側に停止します。Worker route CRUD は
Resource 作成や hostname 予約ではなく、Ready Resource 上の Interface mutation です。

## S3-compatible Object Storage endpoint

`/v1/capabilities` が `compat.s3.v1` の data plane を公開している場合、S3-compatible
エンドポイントから既存の S3 SDK / S3-compatible OpenTofu provider で Takosumi Cloud の
`ObjectBucket` を利用できます。AWS API 完全互換ではなく、別の bucket lifecycle API でもありません。

```http
GET  /compat/s3/v1/__takosumi/status
GET  /compat/s3/v1
HEAD /compat/s3/v1/{bucket}
GET  /compat/s3/v1/{bucket}?list-type=2
GET  /compat/s3/v1/{bucket}/{key}
HEAD /compat/s3/v1/{bucket}/{key}
PUT  /compat/s3/v1/{bucket}/{key}
DELETE /compat/s3/v1/{bucket}/{key}
```

通常の Cloud API key (Takosumi Accounts パーソナルアクセストークン) は S3 SDK の
クレデンシャルではありません。S3-compatible エンドポイントは AWS SigV4 形式のアクセスキー
/ シークレットアクセスキーを検証します。各アクセスキーは明示的な Workspace Principal と
空でない許可バケット一覧に紐づきます。バケット名から canonical `ObjectBucket`、その Resource が
所有する一意な認可済み `storage.object/v1` `Interface`、一致する一意な `NativeResource` を解決し、
静的な Worker binding は使いません。Resource が `Ready`、Principal に正確な read / write / list
Interface 権限があり、Cloud data-plane adapter がその NativeResource 向けに request を再署名できる
場合だけ data request を処理します。tenant の署名と secret を storage provider へ転送しません。

bucket の作成・更新・import・削除は通常の `/v1/resources` preview / review / apply lifecycle で
行います。bucket-level の S3 mutation method は `405 MethodNotAllowed` を返し、backend bucket や
別の lifecycle record を作りません。

`GET /compat/s3/v1/__takosumi/status` は SigV4 なしで読める運用状態です。Dashboard
はこのステータスで設定済みバケット数を表示します。

対応する data operation は、その `ObjectBucket` に capture 済みの immutable な価格証跡から中央の
Cloud usage ledger が評価します。価格・capture・invoice・支払い authority のどれかが欠ける場合は
storage に触れる前に安全側へ停止します。usage event は source Workspace と canonical Resource を
保持し、compatibility handler 自身は価格も並行 billing ledger も持ちません。

## API keys

Dashboard で作成する Cloud API key は Takosumi Accounts のパーソナルアクセス
トークンです。作成時に一度だけシークレット値を返します。

```http
GET  /v1/account/tokens
POST /v1/account/tokens
POST /v1/account/tokens/{tokenId}/revoke
```

通常の Cloud エンドポイント用 key は次の scope で作成します。

```json
{
  "scopes": ["read", "write"],
  "workspace_id": "space_xxx"
}
```

`read` は `GET` / `HEAD` / `OPTIONS` に使います。`write` は互換
リソースの作成、更新、削除などの変更 route に必要です。通常利用で
`admin` は不要です。

一覧レスポンスにはシークレット値を返しません。画面表示・失効操作に使ってよい
メタデータは `id`、`name`、`prefix`、`scopes`、`created_at`、`expires_at`、
`revoked_at`、`last_used_at` です。`subject` は所有者検証用のアカウントプレーン
メタデータで、シークレットではありません。

`GET /v1/account/tokens` は `limit` と `cursor` を受け取り、response に
`next_cursor` を返します。画面は最後の page まで読みます。

## Usage

Cloud の使用量は Workspace 単位の使用量イベントとして記録します。

```http
GET /api/v1/workspaces/{workspaceId}/billing
GET /api/v1/workspaces/{workspaceId}/usage
```

画面の使用量カードはこの 2 つを使います。

| 表示                 | 読み方                                             |
| -------------------- | -------------------------------------------------- |
| 今月の使用量         | 今月発生した使用量イベントの `usdMicros` 合計      |
| Cloud リソース使用量 | `gateway_` で始まる kind の `usdMicros` 合計       |
| 利用可能残高         | billing projection の `balance.availableUsdMicros` |
| 最近の使用量         | `createdAt` が新しい使用量イベント                 |

主な使用量 kind:

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

使用量イベントは quantity、usdMicros、source、timestamp を持ちます。プロバイダの
クレデンシャル、API key、ベアラートークン、database URL、DSN、パスワードなどのシークレット
値を持ってはいけません。

Cloud マネージドエンドポイントは使用量を所有者アカウントの使用量レジャーに記録し、発生元
Workspace を帰属メタデータとして残します。レジャー
に記録できない成功は返しません。残高不足、Workspace コンテキスト不足、未価格付け、
scope 不一致では、下流のプロバイダ、AI アップストリーム、ランタイムディスパッチへ進まず安全側に
停止します。

Edge runtime は canonical Ready `EdgeWorker` と InterfaceBinding を確認した後、Resource / Workspace
それぞれの秒・日・請求期間 quota と credit reservation を先に確保します。durable
`gateway_request` capture の成功が accepted dispatch です。この時点より後の tenant error や
dispatch failure は課金対象で、前の失敗は tenant code を実行しません。dispatch には
`10 CPU-ms` と `5 subrequests` の hard limit が付き、Workers Logs / Logpush は Stable では
無効です。

価格は Cloud エンドポイントのリクエストボディではなく Takosumi Cloud 側で決めます。リクエスト
ボディやクライアントヘッダに `usdMicros` / `credits` を書かせません。公開価格と無料枠は
[Takosumi Cloud pricing](./pricing.md) と Dashboard の請求表示に出します。
active offering の exact SKU / unit / unit price / minimum charge / tax policy / catalog version
は公開リファレンスと quote に出します。同期手順、secret、決済プロバイダ連携の運用詳細だけを
operator runbook 側で管理します。

後処理は拡張と分けます。作成、デプロイ、ランタイム、データプレーンの書き込み / クエリ / メッセージ
/ インスタンス操作は課金対象で、クレジットが足りない場合は安全側に停止します。
一方で DELETE の後処理は、残高切れでユーザーデータやマネージドリソースが取り残されない
よう、原則として代替使用量を持たせません。

画面、請求、使用量レジャー、公開 Resource identity は `EdgeWorker` / `ObjectBucket` / `KVStore` /
`SQLDatabase` / `Queue` / `DurableWorkflow` などの service form と versioned SKU を使い、内部
backend 名を公開課金 family にしません。Stable contract 外または exact meter を持たない request を
backend へ素通ししません。

Takosumi 側で請求できていると言える条件は、所有者アカウントの使用量レジャーに使用量イベント
が記録され、billing projection へ反映されることです。上流プロバイダの請求だけでは
Takosumi ユーザーへの請求完了を意味しません。active PriceCatalog の exact price は公開し、
決済プロバイダへの export / reconciliation 手順と secret だけを operator runbook に置きます。

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

OpenAI-compatible クライアントからは次のように使えます。

```bash
OPENAI_BASE_URL=https://app.takosumi.com/gateway/ai/v1
OPENAI_API_KEY=takpat_...
OPENAI_MODEL=takosumi/default
```

`takosumi/default` は安定したデフォルトエイリアスです。operator はそのエイリアスを
Cloudflare AI Gateway / Unified Billing、Workers AI、または別の
OpenAI-compatible アップストリームにルーティングできます。`/models` とステータスレスポンスは
公開モデルエイリアスとレディネスメタデータだけを返し、アップストリームキーやシークレット
環境変数名を返してはいけません。

## OpenTofu provider usage

通常の OpenTofu provider は provider catalog への登録を必要としません。すべて
`opentofu-default` で実行され、Credential Recipe は Connection 作成を補助するだけです。
Recipe がない provider は、provider 公式仕様に従った generic env/file Connection を
使います。利用可能な組み込み Recipe は `GET /api/v1/credential-recipes` で確認できます。

provider の向き先と credential は Provider Binding / Provider Connection で選びます。
マニフェストに生のシークレットを書いてはいけません。

## Cloud resources inventory

Cloud 画面のリソース一覧は canonical `/v1/resources` inventory の投影です。
Stable contract は次の 7 service form（8 offering）です。

- Edge Worker
- Object Storage Standard / Infrequent Access offering
- KV / Database / Queue
- AI Gateway
- Verified Custom Domain

Vector Index / Durable Workflow / Container / Stateful Actor Namespace / Schedule は Preview で、
active offering がある場合だけ同じ一覧に状態を表示します。Compatibility API profile の
仮想 inventory や独自 Resource 台帳は使いません。Dashboard、`takosumi/takosumi` provider、
direct Deploy API はすべて同じ Resource に収束します。`resource_shapes` capability は型付き Resource Shape API が
使えることを示すもので、別の lifecycle を意味しません。

## Security contract

Cloud エンドポイントの契約では次を守ります。

- シークレット値は作成時以外に再表示しません
- 使用量 / カタログ / ステータス / モデルメタデータにシークレット形式の値を入れません
- platform worker は API key / session の有効性と read/write scope を検証します
- Cloud エンドポイントは Workspace / account / virtual account のリソーススコープを検証します
- 未対応の route は互換のように見せて成功させず、安全側に停止します
- OSS Takosumi に Cloud 専用のバックエンドを持ち込みません

## Availability

Cloud エンドポイントの利用可否はカタログと互換性マトリクスで公開します。
エンドポイントファミリが設定されていない場合、route は管理外のアップストリームへ
暗黙に迂回したり偽の成功を返したりせず、安全側に停止します。
