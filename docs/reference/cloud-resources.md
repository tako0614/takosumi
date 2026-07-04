# Takosumi Cloud Resources

Takosumi Cloud は、公式 managed targets 上で app / service / data resource を
提供する hosted Takosumi for Operator です。`EdgeWorker` は複数ある service
form の一つです。

```text
Takosumi Cloud Resources =
  EdgeWorker
  + ContainerService
  + ObjectBucket
  + KVStore
  + SQLDatabase
  + Queue
  + AI Gateway
  + routes / domains / secrets
  + USD credits / usage metering
  + OpenTofu deploys
```

Cloudflare-compatible API は product identity ではありません。既存の
Cloudflare Workers 向け Terraform/OpenTofu manifest を Takosumi Cloud の
`EdgeWorker` と managed bindings へ取り込む import / deploy path です。

## Product Vocabulary

通常の landing / UI では次の語彙を使います。

- App / Service
- Edge Worker
- Container
- Bindings
- Routes
- Default URL
- Custom Domain
- Secrets
- KV
- Object Storage
- Database
- Queue
- AI Gateway
- Durable Workflow

`compat.cloudflare.workers.v1` は architecture / compatibility docs の capability 名に
留めます。headline と主要 UI では Takosumi Cloud resources / services を主語にします。

## Runtime Architecture

`EdgeWorker` は edge JavaScript / TypeScript app の service form です。Takosumi
Cloud では Cloudflare Workers for Platforms と Takosumi-managed dispatch layer で
実装できます。

これは Cloud の実装詳細です。Cloud の resource model は `EdgeWorker` に限定しません。
OCI image で動く service は `ContainerService`、object storage は `ObjectBucket`、
relational / app database は `SQLDatabase`、durable workflow は別 shape として扱います。

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

参考:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Domains And Routes

公開 HTTP resource は、Takosumi 管理の default URL を持てます。ユーザーは
DNS-valid な 1 ラベルを選び、早いもの勝ちで `*.app.takos.jp` 配下の名前を
予約できます。

```text
https://my-app.app.takos.jp
```

custom domain は同じ route に追加するユーザー所有 hostname です。Dashboard /
OpenTofu route lifecycle は次を扱います。

| Field              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `default_hostname` | Takosumi managed `*.app.takos.jp` hostname  |
| `custom_domains`   | verified or pending user-owned hostnames    |
| `pattern`          | route pattern used by compatibility imports |
| `target`           | EdgeWorker / ContainerService target        |

`default_hostname` は first-come-first-served です。未指定の場合は
`<app-slug>-<short-id>.app.takos.jp` のような安全な fallback を Takosumi が発行します。

## Compatibility Matrix

Cloudflare import capability は `compat.cloudflare.workers.v1` です。
Workers-oriented resource を Takosumi Cloud resources に取り込むために必要な
subset だけを公開します。対応しない Cloudflare product は明示します。

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy to `EdgeWorker`                                   |
| Stable      | Worker routes to Takosumi routes / default hostnames                   |
| Stable      | Worker secrets / vars                                                  |
| Stable      | KV namespace                                                           |
| Stable      | R2 bucket / Object Storage                                             |
| Stable      | D1 database / App Database                                             |
| Preview     | Queue                                                                  |
| Preview     | Durable Workflow                                                       |
| Preview     | Dynamic Worker workflow support                                        |
| Planned     | Containers                                                             |
| Planned     | Durable Objects style stateful apps                                    |
| Unsupported | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported | Email Routing                                                          |

AI Gateway は Workers compatibility ではありません。別の OpenAI-compatible
endpoint profile です。詳細は [Cloud endpoints](./cloud-endpoints.md#ai-gateway)
を参照してください。

## OpenTofu Import Path

Cloudflare-compatible API は、Cloudflare Workers-oriented manifest の import path
です。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

docs では次の言い方にします。

```text
Deploy apps and managed resources to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when importing Workers-oriented apps.
```

本物の Cloudflare に向けるか Takosumi Cloud に向けるかは、引き続き
ProviderConnection / ProviderBinding で切り替えます。manifest に raw secret を
書いてはいけません。

Takosumi Cloud では、この import path は app installation 登録なしでも使えます。
ただし認証済み token と課金対象 Workspace は必須です。billable な write は
Workspace credits から引かれ、残高不足なら compatibility endpoint の実行前に止まります。
