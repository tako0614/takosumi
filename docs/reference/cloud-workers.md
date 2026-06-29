# Takosumi Cloud Workers

Takosumi Cloud Workers は、Worker-compatible apps をホストするための
Takosumi Cloud 専用 runtime です。ユーザーには Worker、bindings、routes、
secrets、usage credit、OpenTofu deploy を持つ application hosting として見せます。

```text
Takosumi Cloud Workers =
  Worker-compatible app hosting
  + managed bindings
  + USD credits / usage metering
  + OpenTofu deploys
```

Cloudflare-compatible API は product identity ではありません。既存の
Cloudflare Workers 向け Terraform/OpenTofu manifest を Takosumi Cloud へ
取り込むための import / deploy path です。

## Product Identity

通常の landing / UI では次の語彙を使います。

- Worker
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
留めます。headline と主要 UI では Worker-compatible hosting を主語にします。

## Runtime Architecture

Workers-compatible HTTP apps は Cloudflare Workers for Platforms を基盤にします。
ユーザーの app は Worker-like script としてデプロイされ、Takosumi が管理する
dispatch layer 経由で実行されます。

Cloudflare の Workers for Platforms docs では、dispatch namespace が customer
Workers を保持し、dynamic dispatch Worker が `env.DISPATCHER.get(...)` で user
Worker を呼び出し、user Worker に KV / D1 / R2 などの bindings を渡せる構成として
説明されています。

Durable user workflow は Workers for Platforms 一本に寄せません。利用可能な場合は
Cloudflare Dynamic Workers と `@cloudflare/dynamic-workflows` を使い、runtime-loaded
Dynamic Worker の code に durable steps を提供します。Cloudflare の Dynamic
Workflows docs では、この library が Worker Loader と Workflows engine を接続し、
Dynamic Worker に `step.do()` / `step.sleep()` / `step.waitForEvent()` を使わせる構成として
説明されています。

Operator/internal jobs は normal Cloudflare Workflows を使います。これは user app
runtime ではなく、operator-side orchestration です。

```text
Workers-compatible HTTP apps:
  Cloudflare Workers for Platforms dispatch namespace

Durable user workflows:
  Cloudflare Dynamic Workers + @cloudflare/dynamic-workflows where available

Operator/internal jobs:
  Cloudflare Workflows
```

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Domains And Routes

Takosumi Cloud Workers は、各 Worker に Takosumi 管理の default URL を発行します。
ユーザーは DNS-valid な 1 ラベルを選んで `*.app.takos.jp` を予約できます。

```text
https://my-app.app.takos.jp
```

custom domain は同じ Worker route に追加する hostname です。Dashboard / OpenTofu
route lifecycle は次を扱います。

| Field              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `default_hostname` | Takosumi managed `*.app.takos.jp` hostname  |
| `custom_domains`   | verified or pending user-owned hostnames    |
| `pattern`          | route pattern used by compatibility imports |
| `script`           | Worker script that serves the route         |

`default_hostname` は first-come-first-served です。既に予約済みの hostname は
409 を返します。route を削除すると、その `*.app.takos.jp` hostname は解放されます。
未指定の場合は `<app-slug>-<short-id>.app.takos.jp` 形式で自動発行します。

custom domain の DNS ownership verification と certificate provisioning は Cloud
runtime の責務です。OpenTofu import endpoint では route record に
`default_hostname` と `custom_domains` を保持し、unsupported / unverified runtime
dispatch は Cloud 側で fail closed します。

## Compatibility Matrix

Takosumi Cloud Workers の import capability は `compat.cloudflare.workers.v1` です。
Workers-compatible hosting に必要な subset だけを公開します。対応外の Cloudflare
product は compatibility matrix で明示します。

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy                                                   |
| Stable      | Worker routes                                                          |
| Stable      | Worker secrets                                                         |
| Stable      | Worker vars                                                            |
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

## OpenTofu Import Path

Cloudflare-compatible API は、Cloudflare Workers-oriented manifest を Takosumi
Cloud Workers へ向ける import path です。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

Docs の主語はこれにします。

```text
Deploy Worker-compatible apps to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when convenient.
```

同じ manifest を本物の Cloudflare に向けるか Takosumi Cloud Workers に向けるかは、
Provider Binding / Provider Connection で切り替えます。manifest に raw secret を
書いてはいけません。

AI Gateway は Workers compatibility ではなく、別の OpenAI-compatible endpoint
profile です。詳細は [Cloud endpoints の AI Gateway](./cloud-endpoints.md#ai-gateway)
を参照してください。
