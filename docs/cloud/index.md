# Takosumi Cloud

Takosumi Cloud は、公式にホストされた Takosumi for Operator です。
Git-based OpenTofu control plane、managed targets、native resources、
USD credits / usage metering、operator support を公式運用として提供します。
Takosumi の core は plain OpenTofu stacks as-is を実行でき、Cloud はその上に
official managed targets と billing を足します。

最初の主力 offering は Takosumi Cloud Workers です。Git からアプリを追加し、
Worker-compatible runtime で動かし、KV / Object Storage / Database / Queue /
AI などを bindings として使えます。deploy と更新は OpenTofu/Terraform ベースで
記録され、使用量は USD credit から差し引かれます。

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + native resources
  + billing / credits / usage metering
  + support / operations

Takosumi Cloud Workers =
  Worker-compatible app hosting offering
  + managed bindings
  + OpenTofu deploy path
```

## 何ができるか

- Worker-compatible app をホストする
- `*.app.takos.jp` の URL をすぐ使う
- ユーザー所有ドメインを custom domain として割り当てる
- Secret と environment variables を設定する
- KV / Object Storage / Database / Queue / AI を binding として使う
- Git URL から OpenTofu/Terraform deploy を実行する
- 使用量、残高、API key、resource inventory を Dashboard で確認する

## Runtime

HTTP app は Takosumi Cloud Workers として動きます。これは
Cloudflare Workers for Platforms を基盤にした Worker-compatible runtime です。
ユーザーの app は Worker-like script としてデプロイされ、Takosumi が管理する
dispatch layer 経由で実行されます。

Durable workflow は、利用可能な場合に Dynamic Workers と
`@cloudflare/dynamic-workflows` を使います。operator/internal jobs は normal
Cloudflare Workflows を使います。

| App type                    | Runtime backing                                   |
| --------------------------- | ------------------------------------------------- |
| HTTP Worker-compatible apps | Workers for Platforms dispatch namespace          |
| Durable user workflows      | Dynamic Workers + `@cloudflare/dynamic-workflows` |
| Operator/internal jobs      | Cloudflare Workflows                              |

## Managed Bindings

Takosumi Cloud の resource は、Worker から binding として使います。

| User-facing name | Purpose                         |
| ---------------- | ------------------------------- |
| Worker           | HTTP app / API / app runtime    |
| Route            | public URL / routing rule       |
| Secrets          | write-only runtime secrets      |
| KV               | small key-value data            |
| Object Storage   | files and large objects         |
| Database         | app relational data             |
| Queue            | async jobs and event processing |
| AI Gateway       | OpenAI-compatible AI endpoint   |
| Durable Workflow | durable multi-step execution    |

## Domains

すべての Worker は、Takosumi 管理の default URL を持ちます。ユーザーは
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
完了したあと同じ Worker route に紐づけます。

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
| Workers          | Stable  |
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
manifest を Takosumi Cloud に向けたいときに使います。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

詳細:

- [Takosumi Cloud Workers](../reference/cloud-workers.md)
- [Takosumi Cloud endpoints](../reference/cloud-endpoints.md)
