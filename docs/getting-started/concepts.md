# Concepts — Shape × Provider × Template

Takosumi の manifest は 3 つの語彙だけで構成されます。 ここでは新しい
operator が **5 分で全体像を掴む** ためのモデル図を示します。

[Quickstart](/getting-started/quickstart) で `takosumi deploy` を 1 回通した
あとに読むのがおすすめです。

---

## 3 つのレイヤー

```
            ┌────────────────────────────────────────────┐
            │ Manifest (YAML / JSON)                     │
            │  • template:        ← Template invocation  │
            │  • resources[]:     ← Shape resources      │
            └────────────┬───────────────────────────────┘
                         │ expand / validate
                         ▼
            ┌────────────────────────────────────────────┐
            │ Shape catalog (5 種、Takosumi が curate)   │
            │   web-service / object-store / postgres /  │
            │   custom-domain / worker                   │
            └────────────┬───────────────────────────────┘
                         │ selection (provider が implements)
                         ▼
            ┌────────────────────────────────────────────┐
            │ Provider plugins (21 個、7 cloud + selfhost)│
            │   @takos/aws-fargate, @takos/cloudflare-r2,│
            │   @takos/selfhost-systemd, ...             │
            └────────────────────────────────────────────┘
```

| Layer        | 何を表すか                                           | 誰が owner か                |
| ------------ | ---------------------------------------------------- | ---------------------------- |
| **Template** | 複数 Shape を 1 invocation で expand する高位構造     | Takosumi (RFC で追加)         |
| **Shape**    | portable な resource 型 (S3-class bucket / HTTP svc) | Takosumi (RFC で追加)         |
| **Provider** | Shape を実装する具体実装 (cloud-specific)             | operator / plugin author     |

---

## Shape

**Shape は portable な resource 型**。manifest が宣言するのは「Postgres
が欲しい」「object-store が欲しい」という **抽象** だけで、どの cloud で
動くかは Shape には書きません。

公式 Shape は 5 種類:

| Shape                  | 用途                                                 |
| ---------------------- | ---------------------------------------------------- |
| `web-service@v1`       | OCI image を long-running HTTP service として起動    |
| `object-store@v1`      | S3 互換の bucket (versioning / SSE / presigned URL)  |
| `database-postgres@v1` | managed PostgreSQL (wire-protocol portable)          |
| `custom-domain@v1`     | DNS record + TLS termination で公開ドメインを構築   |
| `worker@v1`            | `js-bundle` artifact を edge / serverless で実行     |

各 Shape は:

- **Spec** — manifest が書く field の型 (`image`, `port`, `version` 等)
- **Outputs** — apply 後に確定する値 (`url`, `connectionString` 等)
- **Capabilities** — provider が optional で `versioning` / `auto-tls` 等を
  declare する

新しい Shape の追加は breaking change として扱われ、RFC が必要です
(cf. [Extending](/extending#新しい-shape-を-rfc-する))。

詳細: [Shape Catalog](/reference/shapes)

---

## Provider

**Provider は Shape の具体実装**。同じ `web-service@v1` でも、
`@takos/aws-fargate` / `@takos/cloudflare-container` / `@takos/kubernetes-deployment` /
`@takos/selfhost-systemd` がそれぞれ違う cloud で同じ shape を提供します。

bundled provider は **21 個**、対応 cloud は **AWS / GCP / Cloudflare /
Azure / Deno Deploy / Kubernetes + selfhost** の 7 系統:

| cloud       | provider 例                                                            |
| ----------- | ---------------------------------------------------------------------- |
| AWS         | `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-s3`, `@takos/aws-route53` |
| GCP         | `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-gcs`, `@takos/gcp-cloud-dns` |
| Cloudflare  | `@takos/cloudflare-container`, `@takos/cloudflare-r2`, `@takos/cloudflare-dns`, `@takos/cloudflare-workers` |
| Azure       | `@takos/azure-container-apps`                                          |
| Deno Deploy | `@takos/deno-deploy`                                                   |
| Kubernetes  | `@takos/kubernetes-deployment`                                         |
| selfhost    | `@takos/selfhost-systemd`, `@takos/selfhost-docker-compose`, `@takos/selfhost-postgres`, `@takos/selfhost-minio`, `@takos/selfhost-filesystem`, `@takos/selfhost-coredns` |

Provider は `provider:` field で **manifest が陽に指定** します。同 Shape の
複数 provider が register されていても、selection は manifest 側 `provider:`
と `requires:` を superset で満たすかで決まります。

詳細: [Provider Plugins](/reference/providers)

---

## Template

**Template は複数 Shape を 1 つの invocation で expand する authoring 短縮**
です。 例えば `selfhosted-single-vm@v1` を 1 行書くと、`web-service` +
`database-postgres` + `object-store` + (任意で) `custom-domain` がまとめて
生成されます。

bundled template は 2 つ:

| Template                | summary                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `selfhosted-single-vm@v1`  | 1 ホスト VM で web + Postgres + filesystem + DNS              |
| `web-app-on-cloudflare@v1` | Cloudflare edge で CF Container + R2 + DNS + pluggable PG     |

template 自体は provider を持ちません。expansion 結果の `resources[]` が
provider id を持ち、通常の DAG / selection に乗ります。

詳細: [Templates](/reference/templates)

---

## Manifest 内での組み合わせ方

manifest envelope は次の 3 つの組み合わせを取りえます:

::: code-group

```yaml [resources[] のみ]
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec: { image: ghcr.io/me/api:v1, port: 8080, scale: { min: 1, max: 3 } }
```

```yaml [template のみ]
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
template:
  template: selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: ghcr.io/me/api:v1
    port: 8080
    domain: api.example.com
```

```yaml [併用 (template の expansion + 追加 resources)]
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
template:
  template: web-app-on-cloudflare@v1
  inputs: { serviceName: app, image: ..., port: 8080, domain: app.example.com }
resources:
  - shape: object-store@v1
    name: backups
    provider: "@takos/aws-s3"
    spec: { name: app-backups, versioning: true }
```

:::

resource 間の配線は **string interpolation** で書きます:

| 記法                            | 意味                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `${ref:<name>.<field>}`         | 別 resource の **non-secret** output field を埋め込む         |
| `${secret-ref:<name>.<field>}`  | secret reference URI (`secret://...`) を埋め込む              |

`${ref:db.connectionString}` のような参照は kernel 側で **DAG edge** に変換
され、topological order で apply されます。詳細は
[Manifest § DAG / topological apply order](/manifest#dag--topological-apply-order)
を参照。

---

## Architecture (kernel + runtime-agent)

Takosumi は **2 process** から成ります。

```
                ┌─ takosumi deploy ───────┐
                │   CLI (local mode = in-process kernel,
                │        remote mode = HTTP)
                └─────────────┬───────────┘
                              │ POST /v1/deployments
                              ▼
                ┌─ takosumi-kernel ──────────────┐
                │   • HTTP API + apply pipeline  │
                │   • state DB (Postgres)        │
                │   • DAG / fingerprint / lock   │
                │   ※ cloud SDK は呼ばない        │
                └─────────────┬──────────────────┘
                              │ POST /v1/lifecycle/apply
                              ▼
                ┌─ takosumi-runtime-agent ───────┐
                │   • cloud REST API             │
                │   • local OS (docker/systemd)  │
                │   ※ credential はここだけ持つ  │
                └─────────────┬──────────────────┘
                              │
                  ┌───────────┼─────────────┐
                  ▼           ▼             ▼
                AWS / GCP / Cloudflare / k8s / OS
```

- **kernel** は `cloud SDK` に直接触らない。`@takos/...` provider は
  `runtime-agent` への HTTP RPC として apply / describe / destroy を発行する。
- **runtime-agent** は cloud credential を持ち、`@takos/aws-fargate` の場合は
  ECS API、`@takos/selfhost-systemd` の場合は `systemctl enable --now` を実行する。
- dev では `takosumi server` 1 つで両方 1 process 内に起動 (`embedded agent`)。
  production では別 host に分離して、kernel 側に cloud credential が漏れない
  境界を作れる。

詳細: [Lifecycle Protocol](/reference/lifecycle), [Operator Bootstrap](/operator/bootstrap)

---

## Where to look next

| 目的                                  | ページ                                            |
| ------------------------------------- | ------------------------------------------------- |
| manifest の YAML を書く               | [Manifest (Shape Model)](/manifest)               |
| Shape の spec / outputs を確認する    | [Shape Catalog](/reference/shapes)                |
| 21 provider の対応 cloud と用途       | [Provider Plugins](/reference/providers)          |
| bundled template の inputs / outputs  | [Templates](/reference/templates)                 |
| `takosumi` CLI コマンド               | [CLI Reference](/reference/cli)                   |
| `POST /v1/deployments` 等の HTTP API  | [Kernel HTTP API](/reference/kernel-http-api)     |
| kernel ↔ agent envelope               | [Runtime-Agent API](/reference/runtime-agent-api) |
| `TAKOSUMI_*` 環境変数                  | [Environment Variables](/reference/env-vars)      |
| apply / destroy / rollback の挙動     | [Lifecycle Protocol](/reference/lifecycle)        |
| operator が provider を wire する手順 | [Operator Bootstrap](/operator/bootstrap)         |
| 自前で provider / shape を増やす      | [Extending Takosumi](/extending)                  |
