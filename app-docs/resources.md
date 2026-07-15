# Takosumi Cloud Resources

Takosumi Cloud は、公式のマネージドターゲット上でアプリ、サービス、データリソースを
提供するホスト型の Takosumi for Operator です。`EdgeWorker` は複数あるサービス形態
(service form) の一つです。

```text
Takosumi Cloud Resources =
  EdgeWorker
  + ContainerService
  + ObjectBucket
  + KVStore
  + SQLDatabase
  + Queue
  + AI Gateway
  + managed routes / URLs / secrets
  + USD-denominated billing / usage metering
  + OpenTofu deploys
```

Cloudflare-compatible API は製品そのものではありません。既存の
Cloudflare Workers 向け Terraform/OpenTofu マニフェストを Takosumi Cloud の
`EdgeWorker` / `ObjectBucket` へ取り込むための限定的な protocol adapter です。

## Product Vocabulary

通常のランディングページや画面では次の用語を使います。

- App / Service
- Edge Worker
- Container
- Bindings
- Routes
- Default URL
- Custom Domain (Planned)
- Secrets
- KV
- Object Storage
- Database
- Queue
- AI Gateway
- Durable Workflow

`compat.cloudflare.workers.v1` はアーキテクチャや互換性ドキュメントの capability 名に
留めます。見出しと主要な画面では Takosumi Cloud のリソースやサービスを主語にします。

## Runtime Architecture

`EdgeWorker` はエッジで動く JavaScript / TypeScript アプリのサービス形態です。Takosumi
Cloud では Cloudflare Workers for Platforms と Takosumi が管理するディスパッチ層で
実装できます。

これは Cloud の実装上の詳細です。Cloud のリソースモデルは `EdgeWorker` に限定しません。
OCI イメージで動くサービスは `ContainerService`、オブジェクトストレージは `ObjectBucket`、
アプリデータベースは `SQLDatabase`、永続ワークフローは別のシェイプとして扱います。

```text
Edge JS app:
  EdgeWorker -> Cloudflare Workers for Platforms dispatch namespace

Container service:
  ContainerService -> Cloudflare Containers or another operator target

Durable user workflow:
  DurableWorkflow -> Dynamic Workers + @cloudflare/dynamic-workflows where available

Operator/internal jobs:
  Cloudflare Workflows
```

すべての Cloud マネージドリソースの control-plane 操作は、実際のバックエンド API を
叩く前に canonical `/v1/resources` Deploy API へ収束します。`takosumi/takosumi`
provider、Dashboard、直接 API はこの lifecycle をそのまま呼び、Cloudflare-compatible
control request は対応する `EdgeWorker` / `ObjectBucket` request へ変換してから同じ
preview / reviewed apply / delete を呼びます。compatibility handler が manager や
parallel lifecycle store を持つことはありません。

```text
compat control request -> typed Resource request
takosumi provider / direct API / Dashboard -> typed Resource request
  -> /v1/resources preview + reviewed apply/delete
  -> auth + Space/Workspace ownership
  -> TargetPool + Policy + ResolutionLock
  -> versioned offering/price quote + reserve
  -> Cloud adapter + selected manager configured check
  -> backend API
  -> canonical Resource / NativeResource / Output / audit + capture/release

compat data request
  -> Ready canonical Resource + authorized Interface / NativeResource
  -> usage guard + selected manager
  -> backend data plane
```

マネージャが未設定のサービス形態は、使用量の事前課金より前に安全側に停止します
(fail closed)。つまり ContainerService などのバックエンドがまだ公式 Cloud に
入っていない場合、クレジットだけ引かれたり、別の互換経路へ暗黙に迂回したりしません。
Stable subset の Worker route は backend resource ではなく、Ready `EdgeWorker` が持つ
canonical system URL に対する `http.route` Interface と exact Principal Binding です。
route CRUD はこの共有 Interface authority を呼び、compatibility KV や backend route
API を持ちません。custom domain は Planned で、現在は所有確認と証明書の管理がないため
Interface 更新前に安全側に停止します。

この共通層では、Cloud が管理するサービス形態ごとにマネージャ記述子を持ちます。
記述子は Takosumi Cloud のサービスファミリ、使用量メーターファミリ、
NativeResource type、現在のマネージャ実装を結びます。サービスファミリは
`takosumi.edge_worker` のような安定した Cloud リソース契約で、使用量メーター
ファミリは課金や互換性のための公開課金分類、マネージャは差し替え可能なバックエンド
実装です。例えば `EdgeWorker` の現在のマネージャは Cloudflare Workers for Platforms
dispatch namespace ですが、公開リソース名は `EdgeWorker` /
`takosumi.edge_worker`、課金メーターは互換インポート経路と価格表に合わせて
`cloudflare.workers_script` です。WfP は実装トークンであり、ユーザー向けの
リソース名や課金単位にはしません。
同じ理由で、Cloud 内部の正規化リソース種別は `object_bucket` /
`sql_database` / `durable_workflow` のようなサービス形態寄りの名前にします。
`r2` や `d1` は Cloudflare-compatible URL トークンや現在のバックエンドプレフィクスに限定し、
共通の操作種別にはしません。

Cloudflare-compatible path はこのパイプラインへの限定的なインポート経路です。GA subset
は `EdgeWorker` と `ObjectBucket` だけで、KV / D1 / Queue / Workflow の
Cloudflare-shaped control route は明示 `501` です。EdgeWorker の現在の公式マネージャが
Workers for Platforms dispatch namespace でも、公開 Resource identity は
`EdgeWorker` のままです。将来マネージャを差し替える場合も、compatibility handler
ではなく TargetPool / adapter / manager descriptor のエビデンスを変えます。

参考:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Delete And Cleanup

Takosumi Cloud が管理するリソースの削除は、何度実行しても結果が変わりません。
すでにバックエンドが消えている場合も成功として扱い、同じ destroy を安全に再試行できます。後処理や destroy はクレジットを使い切った
後も実行できます。

Object Storage のようにデータ量で所要時間が変わるリソースは、削除を受理した後にバックグラウンド
処理で中身を分割削除します。受理されたリソースはアクティブな一覧とデータプレーンから直ちに
外れ、処理の完了までは同じ名前を再利用できません。削除は取り消せず、保存データも復元できません。

ユーザー自身の ProviderConnection で作った BYOC リソースは、元のプロバイダの削除・保持
ポリシーに従います。プロバイダが保持ロックや依存リソースを理由に拒否した場合、Takosumi は
destroy の成功を偽装せず、Run を失敗として記録して修正後の再試行を可能にします。

## Domains And Routes

公開 HTTP surface には、所有権と lifecycle が異なる 2 種類の URL があります。

Capsule install の `public_endpoint` projection は、OSS hostname reservation authority
が所有する managed URL です。Takosumi Cloud の既定ベースドメインは
`app.takos.jp` で、現在の割り当て方式は `scoped` と `vanity` の 2 種類です。

```text
scoped: https://<workspace-handle>-<label>.app.takos.jp
vanity: https://<label>.app.takos.jp
```

`scoped` は DNS 所有確認が不要で vanity 枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` を先着順で予約し、
Workspace の変更不可な owner account の有限枠を 1 つ消費します。どちらもホスト名
予約によるグローバル一意性、予約語、不正利用ポリシーの対象です。

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>`、`vanity` は
`<label>.<managed-base-domain>` を予約します。
重複・枠超過エラーは申請元の Workspace / Capsule 名を公開しません。
マネージドホスト名予約と vanity スロットは Capsule のライフタイムに属し、成功した
Capsule destroy が予約を解放します。

Cloud managed `EdgeWorker` は別に、不透明で再現不能な canonical system URL を持ちます。
その URL は Resource の `url` Output から compat 応答の `system_url` として取得します。
クライアントは `ew-<hash>.<system-base-domain>` のような値を生成・推測してはいけません。
この system URL は compat route が予約する vanity hostname ではなく、route DELETE でも
解放されません。

Stable な Cloudflare-compatible route は、取得済み `system_url` のホストと明示 path を
組み合わせた pattern だけを受理します。1 つの profile-owned `EdgeWorker` につき active
route は 1 つだけで、path wildcard は無し、または末尾 `*` 1 個だけです。host-only、
複数・重複 route、infix wildcard、wildcard hostname、custom hostname は Interface を
変更する前に拒否します。

現在の route evidence は次の通りです。

| Evidence         | Status  | Meaning                                                     |
| ---------------- | ------- | ----------------------------------------------------------- |
| `system_url`     | Current | Resource `url` Output から発見する opaque EdgeWorker URL    |
| route pattern    | Current | canonical host + explicit path + optional terminal `*`      |
| `http.route`     | Current | route id と strong ETag を持つ canonical Interface          |
| InterfaceBinding | Current | exact Principal に `edge.request` を許可する Binding        |
| `custom_domains` | Planned | user-owned verified-domain / certificate lifecycle (未使用) |

route CRUD は Interface / InterfaceBinding authority を呼びます。compatibility KV、backend
route API、別の hostname ownership ledger はありません。更新は strong ETag の CAS、DELETE
は Binding を revoke して Interface を retire しますが、system URL や Capsule の managed
hostname ownership は解放しません。

ユーザー所有 custom domain はマネージド URL とは別の検証済みライフサイクルですが、DNS
所有確認と証明書ライフサイクルは未実装です。現在、非空の
`custom_domains` や canonical system URL 外の compat route pattern は安全側に停止し、
利用可能な custom domain として保存しません。

アプリのインストールやストアでは、この値は `installExperience` の
`public_endpoint` プロジェクションから普通の OpenTofu 変数へ渡します。例えば
`subdomain` は managed URL の label、`url` は managed URL または通常の OpenTofu
変数、`routePattern` は互換 API で使う route pattern です。ユーザー所有 URL を
BYOC provider に渡すことはできますが、Cloud managed target の custom domain として
自動有効化はしません。
Takosumi は `worker_name` や `app_url` という変数名だけを見て意味を推論しません。
store が明示したプロジェクションと input `format` だけが Dashboard の入力 UX と
ホスト名予約の根拠です。

## Compatibility Matrix

Cloudflare インポート capability は `compat.cloudflare.workers.v1` です。
Workers 向けリソースを Takosumi Cloud のリソースに取り込むために必要な
サブセットだけを公開します。対応しない Cloudflare 製品は明示します。

| Status             | Scope                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Production Preview | single-module Worker script deploy / list / read / delete → `EdgeWorker`           |
| Production Preview | discovered canonical system hostname 上の明示 path route → `http.route` Interface  |
| Production Preview | R2 bucket create / list / read / delete → `ObjectBucket`                           |
| Outside GA subset  | KV、D1、Queue、Workflow、Worker binding / secret / vars / assets API (明示 `501`)  |
| Unsupported        | custom hostname、multi-module upload、DNS、WAF、Zero Trust、Registrar、account IAM |
| Unsupported        | Load Balancer、Email Routing                                                       |

AI Gateway は Workers 互換には含まれません。別の OpenAI-compatible
エンドポイントプロファイルです。詳細は [Cloud endpoints](./endpoints.md#ai-gateway)
を参照してください。

## OpenTofu Import Path

Cloudflare-compatible API は、Cloudflare Workers 向けマニフェストのインポート経路
です。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

ドキュメントでは次の言い方にします。

```text
Deploy apps and managed resources to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when importing Workers-oriented apps.
```

本物の Cloudflare に向けるか Takosumi Cloud に向けるかは、引き続き
ProviderConnection / ProviderBinding で切り替えます。マニフェストに生のシークレットを
書いてはいけません。

Takosumi Cloud では、このインポート経路はアプリインストール登録なしでも使えます。
ただし認証済みトークンと課金対象 Workspace は必須です。課金対象の書き込みは
所有ユーザーのアカウントクレジットから引かれ、残高不足なら互換エンドポイントの実行前に止まります。
