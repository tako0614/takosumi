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
  + USD credits / usage metering
  + OpenTofu deploys
```

Cloudflare-compatible API は製品そのものではありません。既存の
Cloudflare Workers 向け Terraform/OpenTofu マニフェストを Takosumi Cloud の
`EdgeWorker` とマネージドバインディングへ取り込むためのインポート経路です。

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

すべての Cloud マネージドリソースは、実際のバックエンド API を叩く前に Cloud 拡張
共通層を通します。入口が Cloudflare-compatible OpenTofu provider、`takosumi/takosumi`
provider、Compatibility API、または Dashboard のどれであっても、認証、発生元の
Workspace コンテキスト、所有者の課金コンテキスト、Resource / NativeResource への正規化、共通のマネージド操作記述子、選択されたマネージャの利用可否確認、使用量 / クレジットガードを通り、その後に
マネージャがバックエンドを選びます。API のエントリポイントは利用者向けプロトコルを決めるだけで、
バックエンドの選択は manager descriptor / dispatch plan の責務です。`takosumi_*` Resource Shape として入る場合は、
その前段で TargetPool / Policy / ResolutionLock も通ります。

```text
OpenTofu provider via compat / takosumi provider via Resource Shape API / Compatibility API / Dashboard action
  -> auth + source Workspace + owner billing account
  -> Resource / NativeResource normalization
  -> TargetPool / Policy / ResolutionLock (Resource Shape entrypoints)
  -> CloudManagedOperation
  -> CloudManagedDispatchPlan
  -> selected manager configured check
  -> usage / credit guard
  -> capability / manager dispatch
  -> selected manager
  -> backend API
```

マネージャが未設定のサービス形態は、使用量の事前課金より前に安全側に停止します
(fail closed)。つまり ContainerService などのバックエンドがまだ公式 Cloud に
入っていない場合、クレジットだけ引かれたり、別の互換経路へ暗黙に迂回したりしません。
Worker route の作成・削除とマネージドデフォルトホスト名も EdgeWorker の操作
として同じ resolver / dispatch plan に乗ります。route だけが互換ハンドラの
内部都合でバックエンド API を直接叩くことはありません。custom domain は Planned で、
現在は所有確認と証明書の管理がないため、バックエンドに渡す前に安全側に停止します。

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

Cloudflare-compatible path はこのパイプラインへのインポート経路です。EdgeWorker の現在の
公式マネージャは Workers for Platforms dispatch namespace を使いますが、API の契約
は `EdgeWorker` / `ObjectBucket` / `KVStore` / `SQLDatabase` / `Queue` などのサービス
形態で固定し、WfP や Cloudflare 固有の名前を公開リソース名にはしません。
将来マネージャを差し替える場合も、エントリポイント URL やプロバイダスキーマではなく、
マネージャ記述子 / TargetPool / adapter のエビデンスを変える形にします。

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

公開 HTTP リソースは、Takosumi が管理する URL を持てます。Takosumi Cloud の既定
ベースドメインは `app.takos.jp` です。現在の割り当て方式は `scoped` と
`vanity` の 2 種類です。

```text
scoped: https://<workspace-handle>-<label>.app.takos.jp
vanity: https://<label>.app.takos.jp
```

`scoped` は DNS 所有確認が不要で vanity 枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` を先着順で予約し、
Workspace の変更不可な owner account の有限枠を 1 つ消費します。どちらもホスト名
予約によるグローバル一意性、予約語、不正利用ポリシーの対象です。

Cloudflare 互換のホスト名を作る route / script-subdomain 書き込みも、
発生元の Workspace と Capsule のコンテキストを必須とし、同じ OSS ホスト名
予約オーソリティを通ります。Cloud 側の KV / Durable Object は route の
ルーティング / 有効化状態を持つだけで、ホスト名の所有を決める記録ではありません。

現在の Dashboard / OpenTofu route ライフサイクルは次を扱います。

| Field              | Status  | Meaning                                      |
| ------------------ | ------- | -------------------------------------------- |
| `default_hostname` | Current | scoped or owner-slot managed hostname        |
| `pattern`          | Current | route pattern used by compatibility imports  |
| `target`           | Current | EdgeWorker / ContainerService target         |
| `custom_domains`   | Planned | user-owned verified-domain lifecycle (unused) |

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>`、`vanity` は
`<label>.<managed-base-domain>` を予約します。
重複・枠超過エラーは申請元の Workspace / Capsule 名を公開しません。
マネージドホスト名予約と vanity スロットは route レコードではなく Capsule のライフタイム
に属します。成功した Capsule destroy が予約を解放します。Cloud 側の route
DELETE はルーティング / 有効化状態を削除するだけで、OSS ホスト名所有権を
解放しません。

ユーザー所有 custom domain はマネージド URL とは別の検証済みライフサイクルですが、DNS
所有確認と証明書ライフサイクルは未実装です。現在、非空の
`custom_domains` やマネージドベースドメイン外の route パターンは安全側に停止し、
ルーティング / 有効化状態に利用可能な custom domain として保存しません。

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

| Status             | Scope                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Production Preview | Worker script deploy to `EdgeWorker`                                   |
| Production Preview | Worker routes to Takosumi routes / default hostnames                   |
| Production Preview | Worker secrets / vars                                                  |
| Production Preview | KV namespace                                                           |
| Production Preview | R2 bucket / Object Storage                                             |
| Production Preview | D1 database / App Database                                             |
| Preview            | Queue                                                                  |
| Preview            | Durable Workflow                                                       |
| Preview            | Dynamic Worker workflow support                                        |
| Planned            | Containers                                                             |
| Planned            | Durable Objects style stateful apps                                    |
| Planned            | User-owned custom domains                                              |
| Unsupported        | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported        | Email Routing                                                          |

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
