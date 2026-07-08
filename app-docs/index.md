# Takosumi Cloud

Takosumi Cloud は、公式にホストされた Takosumi for Operator です。
Git-based OpenTofu control plane、managed targets、Cloud-operated managed service backends、
billing / usage metering、operator support を公式運用として提供します。
Takosumi の core は plain OpenTofu stacks as-is を実行でき、Cloud はその上に
official managed targets と billing を足します。

この docs は `app.takosumi.com` で提供する hosted service としての
Takosumi Cloud の docs です。portable software としての Takosumi /
Takosumi for Operator の docs は
[takosumi.com/docs](https://takosumi.com/docs/) に分けています。

Takosumi Cloud は複数の service form を扱います。Git から app / service を追加し、
必要な resource を binding として接続し、OpenTofu/Terraform ベースで deploy と
更新を記録します。Edge JS runtime、Object Storage、KV、Database、Queue、AI、
Container は並列の managed resource で、使用量は plan、上限、支払い状態に基づいて
管理されます。

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

## 何ができるか

- app / API / service をホストする
- `*.app.takos.jp` の URL をすぐ使う
- ユーザー所有ドメインを custom domain として割り当てる
- Secret と environment variables を設定する
- KV / Object Storage / Database / Queue / AI を binding として使う
- Git URL から OpenTofu/Terraform deploy を実行する
- 使用量、支払い状態、API key、resource inventory を Dashboard で確認する

## Runtime

Edge JS app は `EdgeWorker` resource として動きます。Takosumi Cloud ではこれを
Cloudflare Workers for Platforms を基盤にした runtime で実装できます。これは
Cloud が提供する resource の一つであり、ContainerService、Object Storage、KV、
Database、Queue、AI とは別の service form です。Cloudflare Workers provider
compatibility profile の entrypoints は同じ platform worker に合流し、別 Worker としては deploy しません。
AI Gateway、Cloudflare Workers-compatible profile、S3-compatible endpoint、
Cloud usage endpoint は、同じ hosted Cloud origin 上の Cloud extension boundary で扱います。

Cloud managed resource は、compatibility endpoint、`takosumi/takosumi` provider、
Dashboard のどこから入っても、backend API を叩く前に同じ managed operation
pipeline を通ります。認証、発生元 Workspace context、owner billing context、Resource / NativeResource
正規化、managed-operation dispatch plan、selected-manager availability check、
usage / spend guard、manager dispatch を共通化し、最後に選ばれた manager が
Workers for Platforms、R2、D1、KV、Queue、Containers、または別の operator backend
を使います。認識済み service form でも manager が未設定なら usage charge や
backend API call の前に fail closed し、別の compatibility path へ fallback しません。
入口は user-facing protocol を決めるだけです。Cloudflare-compatible path、
Resource Shape API、Dashboard action、S3-compatible data-plane、AI Gateway request は
すべて dispatch plan まで同じ形に正規化され、backend choice は manager 側が決めます。
billing は Workspace ごとに分離せず、発生元 Workspace を metadata として残しながら
所有ユーザーの account credits から消費します。

Durable workflow は、利用可能な場合に Dynamic Workers と
`@cloudflare/dynamic-workflows` を使います。operator/internal jobs は normal
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

公開 HTTP resource は、Takosumi 管理の default URL を持ちます。ユーザーは
DNS-valid な 1 ラベルを選んで、operator が管理する public base domain 配下の
hostname を早いもの勝ちで予約できます。Takosumi Cloud の既定 base domain は
`app.takos.jp` です。未指定の場合は Takosumi が安全な hostname を自動発行します。

```text
User-chosen:
  https://my-app.app.takos.jp
  https://blog.app.takos.jp

Auto-issued fallback:
  https://<app-slug>-<short-id>.app.takos.jp
```

この URL は preview、初回 deploy、外部 DNS をまだ持っていない app の公開に使います。
これは DNS ownership verification なしで使える managed namespace です。
`*.app.takos.jp` のような managed namespace は custom domain quota とは別枠で、
通常の app install では広く使える前提です。必要なのは DNS-valid な 1 ラベル、
global uniqueness、予約名/abuse policy だけです。
ユーザー所有ドメインを使う場合は custom domain を追加し、DNS ownership verification、
certificate provisioning、plan/quota/abuse policy が完了したあと同じ route に
紐づけます。

```text
Default URL:
  my-app.app.takos.jp

Custom domains:
  app.example.com
  www.example.com
```

managed namespace は first-come-first-served です。同じ hostname を別 route が
予約しようとした場合は失敗します。platform 用の予約名は使えません。失敗時に
claimant の Workspace / Capsule 名は公開しません。
任意の apex / subdomain は所有者 account に紐づく verified domain として扱い、
plan/quota/abuse policy で制限します。
custom domain が未検証・期限切れ・無効化された場合でも、default URL は残します。
これにより DNS 設定ミスやドメイン移管中でも、app の確認と削除ができます。

## Service Rollout

Takosumi Cloud のサービスは、一度に全部 GA 扱いにしません。使えるものから公開し、
Dashboard / docs / billing / destroy proof / runtime guard が揃った段階で
Stable に上げます。

| Stage              | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| Stable             | GA 公開済みで、課金、削除、usage ledger、docs、smoke が揃っている |
| Production Preview | 本番 runtime で使えるが、GA readiness / live billing 証跡の昇格前 |
| Preview            | 使えるが、制限や変更可能性を docs に明示する                      |
| Planned            | product 方向性として公開するが、まだ利用不可                      |

初期 rollout:

| Service          | Stage              |
| ---------------- | ------------------ |
| Edge Worker      | Production Preview |
| Routes           | Production Preview |
| Secrets / Vars   | Production Preview |
| KV               | Production Preview |
| Object Storage   | Production Preview |
| Database         | Production Preview |
| AI Gateway       | Production Preview |
| Queue            | Preview            |
| Durable Workflow | Preview            |
| Containers       | Planned            |
| Stateful apps    | Planned            |

## Billing and Spend Guard

Takosumi Cloud は subscription plan と usage metering で動きます。billable operation は
price book で価格を決め、plan / 上限 / 支払い状態で許可されない場合は実行前に止めます。
cleanup / destroy は上限到達後でも
できるようにし、作った resource が消せなくなる状態を避けます。

公開価格、無料枠、usage 単価、spend guard の契約は
[Takosumi Cloud pricing](./pricing.md) にまとめています。runtime price book、
payment-provider 同期、margin guard、reconciliation は公開 contract ではなく
operator operations の範囲です。

Dashboard では次を確認できます。

- available balance
- this month's usage
- Cloud resource usage
- recent usage events
- API keys
- current Cloud resources

## Compatibility Profiles

Takosumi Cloud は profile ごとに互換範囲を分けます。Cloudflare-compatible API
surface は `compat.cloudflare.workers.v1` の provider compatibility profile で
あり、Cloudflare API 全体の互換ではありません。AI Gateway は別の
OpenAI-compatible profile です。

### `compat.cloudflare.workers.v1`

| Status             | Scope                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Production Preview | Worker script deploy, routes, secrets, vars                            |
| Production Preview | KV namespace, R2 bucket / Object Storage, D1 database / App Database   |
| Preview            | Queue, Durable Workflow, Dynamic Worker workflow support               |
| Planned            | Containers, Durable Objects style stateful apps                        |
| Unsupported        | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported        | Email Routing                                                          |

### AI Gateway OpenAI-compatible profile

| Status             | Scope                             |
| ------------------ | --------------------------------- |
| Production Preview | `/gateway/ai/v1/models`           |
| Production Preview | `/gateway/ai/v1/chat/completions` |
| Production Preview | `/gateway/ai/v1/embeddings`       |

Cloudflare Workers provider compatibility profile は import / deploy path です。
既存の Cloudflare Workers manifest を Takosumi Cloud の `EdgeWorker` と managed
bindings に向けたいときに使います。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

詳細:

- [Takosumi Cloud resources](./resources.md)
- [Takosumi Cloud endpoints](./endpoints.md)
- [Takosumi Cloud pricing](./pricing.md)
