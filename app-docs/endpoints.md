# Takosumi Cloud endpoints

このページは、`app.takosumi.com` が公開する Takosumi Cloud のエンドポイントファミリの
契約です。Takosumi OSS / Takosumi for Operator の移植可能な API とは分けて
扱います。

Cloud 全体の公式な説明は [Takosumi Cloud](./index.md) と
[Takosumi Cloud resources](./resources.md) にあります。このページは、
エンドポイント、使用量、API key、互換 route の契約を確認するための詳細リファレンスです。

アプリ画面の役割は、日常的に見る運用情報をすぐ確認できるようにすることです。
API key、接続状態、今月の使用量、残高、作成済みリソース数を優先して表示します。
仕様、対象範囲、エンドポイントの契約はこのページに集約します。

## 画面とドキュメントの分担

`app.takosumi.com/cloud` は API key とリソースの管理に絞った画面です。

- API key の作成、一覧、失効
- Cloud リソース (KV / Object Storage / Database / Worker) の一覧、ID コピー、削除
- AI Gateway の Base URL、接続状態、既定モデル
- OpenTofu import endpoint の Base URL と現在の virtual account
- Object Storage endpoint の Base URL と S3-compatible bucket 設定状態

使用量と請求は Cloud 画面ではなく、請求画面 (`app.takosumi.com/billing`) に置きます。

- 今月の使用量、Cloud リソース使用量、利用可能残高
- 使用履歴 (使用量イベントの記録)

リソースを削除すると、共通の Cloud マネージドリソース操作境界に削除アクションが
送られます。Cloudflare 形式のインポート経路で作られたリソースは、互換インポート
エンドポイントの DELETE でも削除できます。削除には `write` scope のセッションが必要で、Cloud
マネージドリソースが作成済みのときだけ反映されます。未対応のエンドポイントファミリは 501
を返して安全側に停止します。DELETE の後処理は課金対象の fallback 操作ではないため、
所有アカウントの残高が尽きた source Workspace でも、作成済みのマネージドリソースを
destroy・削除できます。画面にはすべての仕様を載せません。プロバイダ互換の対応範囲、
OpenTofu provider の設定例、使用量イベントの契約、シークレットの扱いはドキュメント側で確認してください。

## 境界

Takosumi OSS は Git ベースの OpenTofu コントロールプレーン、Resource Shape API、
Compatibility API フレームワーク、Adapter システムを持ちます。

Takosumi for Operator / Cloud の運用層だけが次を持ちます。

- AI Gateway
- Takosumi Cloud resources
- official hosted Cloudflare-compatible import endpoint backend
- official S3-compatible Object Storage endpoint backend
- official managed target / native resource backend
- official usage / quota / billing / support controls

公式の `app.takosumi.com` は、Cloud エンドポイントファミリを同じホスト型プラットフォームオリジンで
提供します。AI Gateway、Cloudflare-compatible インポートエンドポイント、
S3-compatible Object Storage エンドポイント、Cloud 使用量、Cloud Edge Runtime は
Takosumi Cloud のマネージドバックエンドで処理されます。マネージドバックエンドの内部実装、
シークレット、operator 専用レコードは公開契約ではなく、operator runbook 側で
管理します。
すべての managed エンドポイントファミリは、backend API を呼び出す前に、同じ Cloud
マネージドオペレーション境界へ正規化されます。Cloudflare-compatible な経路、
`takosumi_*` Resource Shape の呼び出し、S3-compatible なデータプレーン request、AI
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

`configured: false` の拡張は、画面に表示されても実行時には安全側に停止します。
このカタログには、公開エンドポイントと capability だけを列挙します。
`authMode: "handler"` は、S3 SigV4 のようにエンドポイントファミリ自身が標準の署名を
検証することを示すカタログ値です。この場合はプラットフォームセッション / PAT ではなく
プロトコルの署名を検証し、偽装できる Takosumi コンテキストヘッダと cookie は削除します。
`*.app.takos.jp` / `*.app-staging.takos.jp` に向いた Takosumi Cloud のパブリック HTTP トラフィックは、
同じホスト型オリジンのホスト名ディスパッチレジストリを通って Cloud ランタイムに送られます。

## API key / owner billing context

`takosumi` provider が使う Resource Shape API (`/v1/resources` /
`/v1/target-pools` / `/v1/space-policies`) と Cloudflare-compatible インポート
エンドポイント (`/compat/cloudflare/client/v4`) は匿名では使えません。アカウントセッション、
パーソナルアクセストークン、またはサービストークンで認証し、発生元 Workspace と所有ユーザーの
課金アカウントを検証できる必要があります。マネージドホスト名を作成する Workers route /
script-subdomain 書き込みは例外なく、既存の発生元 Workspace と Capsule のコンテキスト
を両方必要とします。

セッションやパーソナルアクセストークンは `x-takosumi-cloud-billing-workspace-id` で
発生元 Workspace を指定できます。プラットフォームはそのトークンが Workspace を読めることを
アカウントプレーンで確認してから、所有ユーザーの課金アカウント / クレジット残高を解決し、対象の Cloud
エンドポイントファミリまたは Resource Shape API へ転送します。
Cloudflare provider など任意ヘッダを付けにくい OpenTofu provider で使う API key は、
作成時に `workspace_id` を指定したパーソナルアクセストークンにします。この場合プラットフォームは
token introspection の `takosumi.space_id` をデフォルトの発生元 Workspace として使い、
provider 設定は `api_token` と `base_url` だけで動きます。サービストークンはトークンメタデータ
に紐づく Workspace だけを使えます。

Takosumi Cloud が提供するマネージド互換ターゲットを OpenTofu から使う場合は、
その Workspace に紐づくトークンを generic-env ProviderConnection に保存し、runner 環境変数として
`CLOUDFLARE_API_TOKEN` へ注入します。通常の OpenTofu スタックで既存の Cloudflare provider
マニフェストをインポート経路として使う場合は、provider 設定の `base_url` に
Takosumi Cloud の互換エンドポイントを指定します。Resource Shape の TargetPool で
`providerBaseUrl` を持てるのは、operator が許可リストに入れた URL かつ
operator がインストールした `plugin` 実装に限ります。
生成される provider ブロックは `base_url` だけを持ち、シークレットは HCL / plan / state に残りません。
本物の Cloudflare account へ出すターゲットでは、通常どおりユーザーの Cloudflare ProviderConnection
を使います。

課金対象の書き込みは転送前に所有ユーザーのアカウントクレジットから事前課金されます。Workspace コンテキスト
がない、トークンと Workspace が一致しない、または所有ユーザーのクレジットが足りない場合は安全側に
停止し、Cloud エンドポイント / apply 経路へは進みません。マネージドホスト名を変更しない操作では
Capsule コンテキストを省略でき、使用量は Capsule id なしの所有者アカウント使用量イベントとして記録できます。
マネージドホスト名を作る route / script-subdomain 書き込みは発生元 Capsule コンテキストを省略できず、
ホスト名ポリシー / 予約のプリフライトを使用量の事前課金より先に行います。

## S3-compatible Object Storage endpoint

S3-compatible エンドポイントは、Takosumi Cloud が提供する Object Storage を既存の S3
SDK や S3-compatible OpenTofu provider から利用するためのデータプレーンです。AWS API
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

通常の Cloud API key (Takosumi Accounts パーソナルアクセストークン) は S3 SDK の
クレデンシャルではありません。S3-compatible エンドポイントは AWS SigV4 形式のアクセスキー
/ シークレットアクセスキーを検証します。アクセスキーは Workspace と許可バケットに
紐づき、バケット記述子は Takosumi Cloud のマネージドリソース一覧から供給します。

`GET /compat/s3/v1/__takosumi/status` は SigV4 なしで読める運用状態です。Dashboard
はこのステータスで設定済みバケット数を表示します。

書き込み / 読み取り / 一覧操作は Cloud 使用量レジャーに事前課金します。所有ユーザーの USD 残高が
不足している場合、`PUT` はバックエンド書き込み前に `402 PaymentRequired` で止まります。
`DELETE` の後処理は残高不足でも詰まらないよう、操作課金を持たせません。

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
| 今月の使用量         | 今月発生した使用量イベントの `usdMicros` 合計       |
| Cloud リソース使用量 | `gateway_` で始まる kind の `usdMicros` 合計        |
| 利用可能残高         | billing projection の `balance.availableUsdMicros`  |
| 最近の使用量         | `createdAt` が新しい使用量イベント                   |

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

価格は Cloud エンドポイントのリクエストボディではなく Takosumi Cloud 側で決めます。リクエスト
ボディやクライアントヘッダに `usdMicros` / `credits` を書かせません。公開価格と無料枠は
[Takosumi Cloud pricing](./pricing.md) と Dashboard の請求表示に出します。
実際の価格表、同期手順、決済プロバイダ連携の運用詳細は公開リファレンス
ではなく運用メモ側で管理します。

後処理は拡張と分けます。作成、デプロイ、ランタイム、データプレーンの書き込み / クエリ / メッセージ
/ インスタンス操作は課金対象で、クレジットが足りない場合は安全側に停止します。
一方で DELETE の後処理は、残高切れでユーザーデータやマネージドリソースが取り残されない
よう、原則として代替使用量を持たせません。

Takosumi Cloud のマネージドリソースバックエンドは、Cloudflare 向け OpenTofu
マニフェストには `cloudflare_workers_script` / route / KV / R2 / D1 / Queues /
Workflows の Cloudflare 形式互換ビューとして見せられます。一方で画面、
請求、使用量レジャー、公開リソース名では `EdgeWorker`、`ObjectBucket`、
`KVStore`、`SQLDatabase`、`Queue` などのサービス形態を使います。内部バックエンド名は
請求・画面・使用量レジャーの利用者向けファミリには出しません。未対応のマネージド
サブパスは 501 で閉じ、Cloudflare アップストリームへ素通しして無料利用できる状態にはしません。

Takosumi 側で請求できていると言える条件は、所有者アカウントの使用量レジャーに使用量イベント
が記録され、billing projection へ反映されることです。上流プロバイダの請求だけでは
Takosumi ユーザーへの請求完了を意味しません。決済プロバイダへのエクスポート、
照合、価格表の実値は顧客 API ではなく operator runbook の範囲です。

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

## OpenTofu Import Endpoint

Base URL:

```text
https://app.takosumi.com/compat/cloudflare/client/v4
```

`compat.cloudflare.workers.v1` の Cloudflare v4 形式サブセットです。目的は
`cloudflare/cloudflare` OpenTofu/Terraform provider の `base_url` を変えて、
Workers 向けリソースを Takosumi Cloud `EdgeWorker` / マネージドバインディングに
向けられるようにすることです。これは既存マニフェストを取り込むためのインポート /
デプロイ経路であり、Cloudflare API 全体の互換ではありません。

Takosumi Cloud の公式マネージドターゲットでは、このエンドポイントは operator が許可リストに入れた
互換 URL として扱います。`EdgeWorker` だけでなく、R2/KV/D1/Queue 相当の
マネージドバインディングも同じ互換エンドポイントを使う場合は、各実装に同じ
`providerBaseUrl` と operator がインストールした `plugin` を設定します。例:

```json
{
  "plugin": "takosumi-cloud-managed",
  "providerBaseUrl": "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

公式マネージドターゲットでは、型付きの `takosumi_*` Resource Shape がこの TargetPool
実装を選ぶと、Takosumi Cloud のマネージドリソースアダプタへ直接ディスパッチされます。
この場合も入口は Resource Shape API のままで、TargetPool / Policy / ResolutionLock を通り、
Cloud 拡張共通層の使用量 / クレジットガードを通ります。Cloudflare 実装は
内部でこの互換ハンドラを再利用するため、EdgeWorker は Workers for Platforms
dispatch namespace に、ObjectBucket / KVStore / SQLDatabase / Queue は選択された
マネージドバックエンドプリミティブに落ちます。

`takosumi_edge_worker` と Cloudflare provider 互換経路は同じ Cloud
マネージドリソース操作境界を通ります。Resource Shape のエントリポイントは
TargetPool / Policy / ResolutionLock / Adapter ディスパッチを使い、互換
エントリポイントは Cloud 拡張カタログ / 認証 / 使用量ガードと互換マネージャの
仮想リソースレジャーを使います。どちらもバックエンド API を叩く前に Workspace
コンテキストと所有者アカウントのクレジットを検証し、裏側の実装はマネージャが決めます。マネージド
互換ターゲットのクレデンシャルはプロバイダネイティブの環境変数配信で渡されるため、
Cloudflare provider は
`CLOUDFLARE_API_TOKEN=<Workspace に紐づく Takosumi トークン>` と `base_url` だけで
Takosumi Cloud の互換エンドポイントを叩きます。Takosumi Cloud の初期 Worker
実装は Workers for Platforms の dispatch namespace を使いますが、
それは `EdgeWorker` 実装の一候補であり、公開 API やプロバイダスキーマには固定
しません。

Cloud マネージドリソースの入口は、Compatibility API、既存 OpenTofu provider、
`takosumi/takosumi` provider の Resource Shape API のどれでも同じ扱いです。
入口ごとの差はリクエスト形式と所有権レジャーです。認証、capability、
所有者アカウントの使用量 / クレジットガード、Resource / NativeResource 正規化、マネージャディスパッチ
は共通に通します。Resource Shape のエントリポイントでは TargetPool / Policy /
ResolutionLock が追加で適用されます。
Cloudflare-compatible エンドポイントは独立した別スタックではなく、この共通 Cloud マネージド
操作境界へのインポート / デプロイ経路です。
Cloud リソースの正式な名前は `EdgeWorker` / `ObjectBucket` などのサービス形態と
`takosumi.edge_worker` などのサービスファミリです。`cloudflare.workers_script` や
`cloudflare.r2` は課金 / 互換メーターの公開分類、Workers for Platforms や R2
は選択されたマネージャ / バックエンド実装です。

レスポンスエンベロープ:

```json
{
  "success": true,
  "result": [],
  "errors": [],
  "messages": []
}
```

Dashboard の一覧表示が使う読み取り route:

```http
GET /compat/cloudflare/client/v4/user/tokens/verify
GET /compat/cloudflare/client/v4/accounts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts
GET /compat/cloudflare/client/v4/accounts/{accountId}/workers/scripts/{scriptName}/subdomain
GET /compat/cloudflare/client/v4/accounts/{accountId}/storage/kv/namespaces
GET /compat/cloudflare/client/v4/accounts/{accountId}/r2/buckets
GET /compat/cloudflare/client/v4/accounts/{accountId}/d1/database
```

D1 database の対応するデータ / メンテナンス route:

```http
POST /compat/cloudflare/client/v4/accounts/{accountId}/d1/database/{databaseId}/query
POST /compat/cloudflare/client/v4/accounts/{accountId}/d1/database/{databaseId}/raw
POST /compat/cloudflare/client/v4/accounts/{accountId}/d1/database/{databaseId}/import
POST /compat/cloudflare/client/v4/accounts/{accountId}/d1/database/{databaseId}/export
```

`import` は `wrangler d1 execute --remote --file ...` が使う
`init` / `ingest` / `poll` プロトコルをそのまま受け付け、テナント内のパブリックデータベース id を
選択済み SQLDatabase マネージャのバックエンド id へ写像します。`query` / `raw` / `import` /
`export` は同じ所有者アカウントのクレジットガードと使用量レジャーを通ります。この一覧にない
D1 サブパスは互換対象ではなく `501` を返します。

初期ターゲットは Workers 系サブセットに限定します。

- Workers scripts
- Workers routes
- Workers script subdomain compatibility mapped to `*.app.takos.jp`
- default `*.app.takos.jp` hostname per HTTP route
- KV namespaces
- R2 buckets
- D1 databases
- Worker vars / secrets / bindings

初期ターゲットではないもの:

- DNS 全般
- WAF / Rulesets
- Zero Trust
- Account IAM
- Cloudflare billing API
- registrar
- load balancer
- email routing
- Turnstile

Planned:

- ユーザー所有 custom domain (所有確認 / 証明書ライフサイクルは未実装)

Cloudflare billing API は互換対象外です。一方で Takosumi Cloud が提供する
マネージドリソースの使用量は Cloudflare billing API ではなく、上記の
所有者アカウント使用量レジャーへ記録する必要があります。

Workers route レコードは次のホスト名フィールドを持ちます。

Request:

```json
{
  "script": "api",
  "app_subdomain": "my-app"
}
```

Response:

```json
{
  "id": "route_xxx",
  "pattern": "my-workspace-my-app.app.takos.jp/*",
  "script": "api",
  "default_hostname": "my-workspace-my-app.app.takos.jp"
}
```

`default_hostname` は即時利用可能な Takosumi マネージド URL です。
`app_subdomain` / `default_hostname` / `hostname` は要求ラベルまたはマネージドホスト名
を指定します。最終ホスト名は発生元 Capsule に保存された
`managedPublicHostname.mode` で決まり、省略時は `scoped` です。
Takosumi Cloud の既定マネージドベースドメインは `app.takos.jp` です。operator は
同じ契約で別のマネージドベースドメインを設定できます。

```text
scoped:
  <workspace-handle>-<label>.<managed-base-domain>
  vanity slot を消費しない

vanity:
  <label>.<managed-base-domain>
  変更不可な Workspace owner account の有限枠を 1 つ消費する
```

どちらも同じ OSS ホスト名予約オーソリティで先着順に
予約します。重複時は 409、vanity 枠超過時は 429 を返し、レスポンスは申請元の
Workspace / Capsule 名を公開しません。Cloud 互換ハンドラは発生元の
Workspace+Capsule コンテキストをオーソリティに渡します。Cloud 側 KV / Durable Object は
ルーティング / 有効化状態だけを持ち、ホスト名の所有を決める記録にはしません。

マネージドホスト名予約と vanity スロットは Capsule のライフタイムに属します。
成功した Capsule destroy が予約を解放します。互換 route の
DELETE は Cloud 側のルーティング / 有効化状態を削除するだけで、OSS ホスト名
所有権や vanity スロットを解放しません。

`custom_domains` は将来の検証済みドメインライフサイクル用に予約された **Planned** フィールド
です。DNS 所有確認と証明書ライフサイクルは未実装のため、現在は
非空の `custom_domains`、`custom_domain`、またはマネージドベースドメイン外の route
パターン / ホスト名を含む要求を 501 で拒否し、安全側に停止します。利用可能な custom domain
として保存・有効化はしません。

`cloudflare_workers_script_subdomain` 互換 route は、Cloudflare の
`workers.dev` ではなく Takosumi マネージド `*.app.takos.jp` 公開名として保存されます。
`POST /accounts/{accountId}/workers/scripts/{scriptName}/subdomain` に
`{"enabled": true, "previews_enabled": false}` を送ると、
発生元の Workspace+Capsule コンテキストと同じ OSS 予約オーソリティを使い、Capsule の
`managedPublicHostname.mode` に応じた scoped または vanity ホスト名の仮想
Workers route を作成します。
`previews_enabled: true` は初期ターゲット外です。

## OpenTofu provider usage

通常の OpenTofu provider は provider catalog への登録を必要としません。すべて
`opentofu-default` で実行され、Credential Recipe は Connection 作成を補助するだけです。
Recipe がない provider は、provider 公式仕様に従った generic env/file Connection を
使います。利用可能な組み込み Recipe は `GET /api/v1/credential-recipes` で確認できます。

Cloudflare provider の例:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

同じ Cloudflare Workers 向けマニフェストを本物の Cloudflare と Takosumi
Cloud のどちらにも向けられるようにするのが狙いです。切り替えはマニフェスト
ではなく Provider Binding / Provider Connection で行います。マニフェストに生の
シークレットを書いてはいけません。

## Cloud resources inventory

Cloud 画面のリソース一覧は Compatibility API から読める現在状態の
要約です。少なくとも次のグループを表示します。

- KV
- Object Storage
- Database
- Workers

この一覧は運用確認用です。ライフサイクルの入口は、Compatibility API、
Cloudflare-compatible OpenTofu provider、`takosumi/takosumi` provider の
Resource Shape API、Dashboard アクションのどれでも構いません。いずれも共通 Cloud
マネージドリソース操作境界に正規化されます。`resource_shapes`
capability は型付き Resource Shape API が使えることを示すもので、別のマネージド
リソースライフサイクルを意味しません。

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
