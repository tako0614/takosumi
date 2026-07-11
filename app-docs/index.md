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

現在、公開 HTTP resource には operator 管理 base domain 配下の managed URL を
割り当てられます。Takosumi Cloud の既定 base domain は `app.takos.jp` です。
割り当て mode は `scoped` と `vanity` の2種類です。

```text
scoped:
  https://<workspace-handle>-<label>.app.takos.jp
  vanity 枠を消費しない

vanity:
  https://<label>.app.takos.jp
  Workspace の immutable owner account の有限枠を1つ消費する
```

この URL は preview、初回 deploy、外部 DNS をまだ持っていない app の公開に使います。
どちらも DNS ownership verification は不要です。`scoped` は vanity 枠を消費せず、
`vanity` は DNS-valid な1ラベル、global uniqueness、owner account の空き枠、
予約名/abuse policy を満たす場合に first-come-first-served で取得できます。
重複・枠超過エラーは claimant の Workspace / Capsule 名を公開しません。
reservation と vanity slot は Capsule lifetime に属し、成功した Capsule destroy で
解放されます。個別 route の削除だけでは解放されません。

ユーザー所有 custom domain は **Planned** です。DNS ownership verification と
certificate lifecycle はまだ実装されていないため、現在の Cloud managed route に
custom domain を指定した要求は fail closed し、利用可能な route として有効化されません。

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
| Custom Domains   | Planned            |

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
| Planned            | User-owned custom domains                                              |
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
