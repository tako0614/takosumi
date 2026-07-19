# Takosumi Cloud

Takosumi Cloud は、私たちが運営する Takosumi の公式ホスティングです。
Git に置いたアプリや API を、ブラウザから `*.app.takos.jp` の URL で公開できます。
ストレージ、データベース、キュー、AI などの managed resource も、必要な分だけ
接続して使えます。料金はプランと使った分の組み合わせです ([料金](./pricing.md))。

この docs は `app.takosumi.com` で提供する hosted service としての
Takosumi Cloud の docs です。自分で動かせる software としての Takosumi /
Takosumi for Operator の docs は
[takosumi.com/docs](https://takosumi.com/docs/) に分けています。

## 何ができるか

- app / API / service をホストする
- `*.app.takos.jp` の URL をすぐ使う
- Secret と環境変数を設定する
- KV / Object Storage / Database / Queue / AI を binding として使う
- Git URL から OpenTofu/Terraform のデプロイを実行する
- 使用量、支払い状態、API key、リソース一覧を Dashboard で確認する

## 提供の形

Takosumi Cloud は、software としての Takosumi (Git を起点に、変更内容の確認 → 反映 →
履歴の記録を行うデプロイ基盤) の上に、公式の実行先と課金・サポートを足したものです。

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + Cloud-operated managed service backends
  + billing / usage metering / spend guard
  + support / operations

Takosumi Cloud Resources =
  official managed resource offerings
  + managed bindings
  + OpenTofu deploy path
```

Git から app / service を追加し、必要な resource を binding として接続すると、
デプロイと更新が記録されます。Edge JS runtime、Object Storage、KV、Database、
Queue、AI、Container は並列の managed resource で、使用量はプラン、上限、
支払い状態に基づいて管理されます。

## Runtime

Edge JS app は `EdgeWorker` resource として動きます。Takosumi Cloud はこれを
Cloudflare Workers for Platforms と Takosumi が管理する dispatch layer で
実装できます。これは Cloud が提供する resource のひとつで、ContainerService、
Object Storage、KV、Database、Queue、AI とは別の service form です。
AI Gateway、S3-compatible endpoint、Cloud usage endpoint は、同じ hosted Cloud
origin 上の Cloud extension boundary を通して提供されます。

どの入口から入っても — Dashboard、`takosumi/takosumi` provider、互換 endpoint の
いずれでも — リクエストは同じ確認の流れを通ります。認証、発生元 Workspace の確認、
支払い主体の確認、リソースの正規化、実行先の空き確認、使用量と上限の確認を経て、
選ばれた backend (Workers for Platforms、R2、D1、KV、Queue、Containers など) が
実行します。実行先が未設定の service form は、課金や backend 呼び出しの前に
安全側に停止し (fail closed)、別の経路へ勝手に迂回しません。課金は Workspace ごとに
分かれず、発生元 Workspace を記録として残しながら、所有ユーザーのアカウント残高から
消費されます。

Durable workflow は、利用可能な場合に Dynamic Workers と
`@cloudflare/dynamic-workflows` を使います。operator/internal jobs は通常の
Cloudflare Workflows を使います。

| Service form           | Backing example                                   |
| ---------------------- | ------------------------------------------------- |
| Edge JS app            | Workers for Platforms dispatch namespace          |
| Container service      | Cloudflare Containers or another operator target  |
| Durable user workflow  | Dynamic Workers + `@cloudflare/dynamic-workflows` |
| Operator/internal jobs | Cloudflare Workflows                              |

## Managed Bindings

Takosumi Cloud の resource は、app / service から binding として使います。

| User-facing name | Purpose                         |
| ---------------- | ------------------------------- |
| Edge Worker      | Edge JS app / API runtime       |
| Container        | OCI image based service         |
| Route            | public URL / routing rule       |
| Secrets          | write-only runtime secrets      |
| KV               | small key-value data            |
| Object Storage   | files and large objects         |
| Database         | app relational data             |
| Queue            | async jobs and event processing |
| AI Gateway       | OpenAI-compatible AI endpoint   |
| Durable Workflow | durable multi-step execution    |

## Domains

現在、公開 HTTP resource には operator 管理 base domain 配下の managed URL を
割り当てられます。Takosumi Cloud の既定 base domain は `app.takos.jp` です。
割り当て mode は `scoped` と `vanity` の 2 種類です。

```text
scoped:
  https://<workspace-handle>-<label>.app.takos.jp
  vanity 枠を消費しない

vanity:
  https://<label>.app.takos.jp
  Workspace の所有アカウントの有限枠を 1 つ消費する
```

この URL は preview、初回デプロイ、外部 DNS をまだ持っていない app の公開に使います。
どちらも DNS の所有確認は不要です。`scoped` は vanity 枠を消費せず、
`vanity` は DNS として有効な 1 ラベルであること、世界で重複しないこと、所有アカウントの
空き枠、予約名 / abuse policy を満たす場合に、早い者勝ちで取得できます。
重複や枠超過のエラーは、先に取得した人の Workspace / Capsule 名を公開しません。
取得済みの名前と vanity 枠は Capsule と同じ寿命を持ち、Capsule の destroy が成功すると
解放されます。個別 route の削除だけでは解放されません。

ユーザー所有の custom domain は GA contract に含まれます。owner account / Workspace に属する
`VerifiedDomain` が ownership challenge、証明書、attach/detach、renewal、expiry、delete を管理し、
ownership と certificate が current の間だけ route を有効にします。本番環境でこの lifecycle の
検証が完了するまでは Takosumi Cloud 全体と同じく Pre-GA で、未確認・期限切れ・degraded な
domain は安全側に停止します。

## GA Contract と Launch Gate

Takosumi Cloud の GA はサービスごとの段階公開ではありません。7 つの Stable service form
（8 offering）を 1 つの Stable 契約として扱い、全項目が同じ readiness matrix を通るまで
Takosumi Cloud 全体を Pre-GA のままにします。

| Status      | Scope                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| GA contract | Edge Worker の modules / assets / vars / write-only secrets / bindings / versions / deployments |
| GA contract | Object Storage の Standard / Infrequent Access offering                                         |
| GA contract | KV / Database / Queue                                                                            |
| GA contract | OpenAI-compatible AI Gateway endpoint                                                           |
| GA contract | Verified custom domain                                                                          |
| Preview     | Vector Index / Durable Workflow / Container / Stateful Actor Namespace / Schedule               |
| Pre-GA      | 上の全項目が同じ Stable evidence matrix を通るまで public GA は開かない                         |

Stable evidence には lifecycle、価格、immutable metering、spend enforcement、invoice reconciliation、
recovery、tenant isolation、Dashboard、本番環境での動作・運用検証が含まれます。self-test、
descriptor、未設定 manager、1 つの green client だけでは GA になりません。

## Billing and Spend Guard

Takosumi Cloud は、サブスクリプションプランと使用量の記録で動きます。課金対象の
操作は active な PriceCatalog で価格が決まり、プラン / 上限 / 支払い状態で許可されない場合は
実行前に止まります。cleanup / destroy は上限に達した後でも実行できるようにし、
作った resource が消せなくなる状態を避けます。

公開価格、無料枠、使用量の単価、spend guard の契約は
[Takosumi Cloud pricing](./pricing.md) にまとめています。決済事業者との同期、
margin guard、突合処理の実装詳細は公開 contract ではなく、サービス運用の範囲です。

Dashboard では次を確認できます。

- 利用可能な残高
- 今月の使用量
- Cloud resource の使用量
- 最近の使用イベント
- API keys
- 現在の Cloud resources

## Standard protocol endpoints

Object Storage は scoped な `compat.s3.v1` data-plane profile を公開します。bucket の
lifecycle authority は canonical Resource API のままで、S3 endpoint は Ready
`ObjectBucket` と認可済み Interface を解決します。

### AI Gateway OpenAI-compatible profile

| Status             | Scope                             |
| ------------------ | --------------------------------- |
| Production Preview | `/gateway/ai/v1/models`           |
| Production Preview | `/gateway/ai/v1/chat/completions` |
| Production Preview | `/gateway/ai/v1/embeddings`       |

詳細:

- [Takosumi Cloud resources](./resources.md)
- [Takosumi Cloud endpoints](./endpoints.md)
- [Takosumi Cloud pricing](./pricing.md)
