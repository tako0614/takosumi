# Takosumi Cloud

Takosumi Cloud は、公式にホストされた Takosumi for Operator です。
Git-based OpenTofu control plane、managed targets、Cloud-operated managed service backends、
USD credits / usage metering、operator support を公式運用として提供します。
Takosumi の core は plain OpenTofu stacks as-is を実行でき、Cloud はその上に
official managed targets と billing を足します。

Takosumi Cloud は複数の service form を扱います。Git から app / service を追加し、
必要な resource を binding として接続し、OpenTofu/Terraform ベースで deploy と
更新を記録します。Edge JS runtime、Object Storage、KV、Database、Queue、AI、
Container は並列の managed resource で、使用量は USD credit から差し引かれます。

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + Cloud-operated managed service backends
  + billing / credits / usage metering
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
- 使用量、残高、API key、resource inventory を Dashboard で確認する

## Runtime

Edge JS app は `EdgeWorker` resource として動きます。Takosumi Cloud ではこれを
Cloudflare Workers for Platforms を基盤にした runtime で実装できます。これは
Cloud が提供する resource の一つであり、ContainerService、Object Storage、KV、
Database、Queue、AI とは別の service form です。Cloudflare compatibility
entrypoints は same platform worker に合流し、not deployed as separate Workers です。

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
DNS-valid な 1 ラベルを選んで、早いもの勝ちで `*.app.takos.jp` を予約できます。
未指定の場合は Takosumi が安全な hostname を自動発行します。

```text
User-chosen:
  https://my-app.app.takos.jp
  https://blog.app.takos.jp

Auto-issued fallback:
  https://<app-slug>-<short-id>.app.takos.jp
```

この URL は preview、初回 deploy、外部 DNS をまだ持っていない app の公開に使います。
ユーザー所有ドメインを使う場合は custom domain を追加し、DNS ownership verification が
完了したあと同じ route に紐づけます。

```text
Default URL:
  my-app.app.takos.jp

Custom domains:
  app.example.com
  www.example.com
```

`*.app.takos.jp` は first-come-first-served です。同じ hostname を別 route が
予約しようとした場合は失敗します。platform 用の予約名は使えません。
custom domain が未検証・期限切れ・無効化された場合でも、default URL は残します。
これにより DNS 設定ミスやドメイン移管中でも、app の確認と削除ができます。

## Service Rollout

Takosumi Cloud のサービスは、一度に全部 GA 扱いにしません。使えるものから公開し、
Dashboard / docs / billing / destroy proof / runtime guard が揃った段階で
Stable に上げます。

| Stage   | Meaning                                            |
| ------- | -------------------------------------------------- |
| Stable  | 課金、削除、usage ledger、docs、smoke が揃っている |
| Preview | 使えるが、制限や変更可能性を docs に明示する       |
| Planned | product 方向性として公開するが、まだ利用不可       |

初期 rollout:

| Service          | Stage   |
| ---------------- | ------- |
| Edge Worker      | Stable  |
| Routes           | Stable  |
| Secrets / Vars   | Stable  |
| KV               | Stable  |
| Object Storage   | Stable  |
| Database         | Stable  |
| AI Gateway       | Stable  |
| Queue            | Preview |
| Durable Workflow | Preview |
| Containers       | Planned |
| Stateful apps    | Planned |

## Credits

Takosumi Cloud は USD credit で動きます。billable operation は price book で価格を
決め、残高が足りない場合は実行前に止めます。cleanup / destroy は残高切れでも
できるようにし、作った resource が消せなくなる状態を避けます。

Dashboard では次を確認できます。

- available balance
- this month's usage
- Cloud resource usage
- recent usage events
- API keys
- current Cloud resources

## Compatibility Profiles

Takosumi Cloud は profile ごとに互換範囲を分けます。Cloudflare-compatible API は
`compat.cloudflare.workers.v1` の import / deploy path であり、Cloudflare API
全体の互換ではありません。AI Gateway は別の OpenAI-compatible profile です。

### `compat.cloudflare.workers.v1`

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy, routes, secrets, vars                            |
| Stable      | KV namespace, R2 bucket / Object Storage, D1 database / App Database   |
| Preview     | Queue, Durable Workflow, Dynamic Worker workflow support               |
| Planned     | Containers, Durable Objects style stateful apps                        |
| Unsupported | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported | Email Routing                                                          |

### AI Gateway OpenAI-compatible profile

| Status | Scope                             |
| ------ | --------------------------------- |
| Stable | `/gateway/ai/v1/models`           |
| Stable | `/gateway/ai/v1/chat/completions` |
| Stable | `/gateway/ai/v1/embeddings`       |

Cloudflare-compatible API は import / deploy path です。既存の Cloudflare Workers
manifest を Takosumi Cloud の `EdgeWorker` と managed bindings に向けたいときに
使います。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

詳細:

- [Takosumi Cloud resources](../reference/cloud-resources.md)
- [Takosumi Cloud endpoints](../reference/cloud-endpoints.md)
