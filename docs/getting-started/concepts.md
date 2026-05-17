# Concepts — Shape × Provider

> このページでわかること: Shape と Provider のモデルを 5 分で理解する。

[Quickstart](/getting-started/quickstart) で `takosumi deploy` を 1 回通したあとに読むのがおすすめ。

---

## 3 つのレイヤー

```
┌────────────────────────────────────────────┐
│ Manifest (YAML / JSON)                     │
│  • resources[]:     ← Shape resources      │
└────────────┬───────────────────────────────┘
             │ validate
             ▼
┌────────────────────────────────────────────┐
│ Shape catalog (5 種、Takosumi が curate)   │
│   web-service / object-store / postgres /  │
│   custom-domain / worker                   │
└────────────┬───────────────────────────────┘
             │ selection (provider が implements)
             ▼
┌────────────────────────────────────────────┐
│ Provider plugins (20 default + 1 opt-in)   │
│   @takos/aws-fargate, @takos/cloudflare-r2,│
│   @takos/selfhost-systemd, ...             │
└────────────────────────────────────────────┘
```

| Layer        | 何を表すか                                           | 誰が owner か            |
| ------------ | ---------------------------------------------------- | ------------------------ |
| **Shape**    | portable な resource 型 (S3-class bucket / HTTP svc) | Takosumi (RFC で追加)    |
| **Provider** | Shape を実装する具体実装 (cloud-specific)            | operator / plugin author |

---

## Shape

Shape は portable な resource 型。 manifest が宣言するのは「Postgres が欲しい」「object-store が欲しい」という抽象だけで、どの cloud で動くかは Shape には書かない。

公式 Shape は 5 種類:

| Shape                  | 用途                                                |
| ---------------------- | --------------------------------------------------- |
| `web-service@v1`       | OCI image を long-running HTTP service として起動   |
| `object-store@v1`      | S3 互換の bucket (versioning / SSE / presigned URL) |
| `database-postgres@v1` | managed PostgreSQL (wire-protocol portable)         |
| `custom-domain@v1`     | DNS record + TLS termination で公開ドメインを構築   |
| `worker@v1`            | `js-bundle` artifact を edge / serverless で実行    |

各 Shape は次を持つ:

- **Spec** — manifest が書く field の型 (`image`, `port`, `version` 等)
- **Outputs** — apply 後に確定する値 (`url`, `connectionString` 等)
- **Capabilities** — provider が optional で `versioning` / `auto-tls` 等を declare する

新しい Shape の追加は breaking change で、RFC が必要 (cf. [Extending](/extending#新しい-shape-を-rfc-する))。

詳細: [Shape Catalog](/reference/shapes)

---

## Provider

Provider は Shape の具体実装。 同じ `web-service@v1` でも、 `@takos/aws-fargate` / `@takos/cloudflare-container` / `@takos/kubernetes-deployment` / `@takos/selfhost-systemd` がそれぞれ違う cloud で同じ shape を提供する。

bundled provider は **20 default + 1 opt-in**、対応 cloud は AWS / GCP / Cloudflare / Azure / Deno Deploy / Kubernetes + selfhost の 7 系統:

- **AWS** — `@takos/aws-{s3,fargate,rds,route53}`
- **GCP** — `@takos/gcp-{gcs,cloud-run,cloud-sql,cloud-dns}`
- **Cloudflare** — `@takos/cloudflare-{r2,container,workers,dns}`
- **Azure** — `@takos/azure-container-apps`
- **Deno Deploy** — `@takos/deno-deploy` (opt-in)
- **Kubernetes** — `@takos/kubernetes-deployment`
- **Selfhost** — `@takos/selfhost-{systemd,docker-compose,postgres,minio,filesystem,coredns}`

Provider は manifest 側 `provider:` field で陽に指定する。 同 Shape の複数 provider が register されていても、 selection は `provider:` と `requires:` を superset で満たすかで決まる。

詳細: [Provider Plugins](/reference/providers)

---

## Template

kernel `POST /v1/deployments` は展開済みの `resources[]` だけを受け取る。 template expansion は installer/compiler layer で kernel request 前に実行する。

---

## Manifest 内での組み合わせ方

current kernel manifest envelope は `resources[]` だけを受ける:

```yaml
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

resource 間の配線は string interpolation で書く:

| 記法                           | 意味                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `${ref:<name>.<field>}`        | 別 resource の **non-secret** output field を埋め込む |
| `${secret-ref:<name>.<field>}` | secret reference URI (`secret://...`) を埋め込む      |

`${ref:db.connectionString}` のような参照は kernel 側で DAG edge に変換され、topological order で apply される。DAG は [Manifest](/manifest#dag) 参照。

---

## Architecture (kernel + runtime-agent) {#architecture-kernel--runtime-agent}

Takosumi は **2 process** から成る。

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

- **kernel** は cloud SDK に直接触らない。`@takos/...` provider は runtime-agent への HTTP RPC として apply / describe / destroy を発行する。
- **runtime-agent** は cloud credential を持つ。 `@takos/aws-fargate` なら ECS API、 `@takos/selfhost-systemd` なら `systemctl enable --now` を実行する。
- dev では `takosumi server` 1 つで両方 1 process 内に起動する (`embedded agent`)。 production では別 host に分離して、 kernel 側に cloud credential が漏れない境界を作れる。

詳細: [Lifecycle Protocol](/reference/lifecycle), [Operator Bootstrap](/operator/bootstrap)

---

## Where to look next

| 目的                                               | ページ                                            |
| -------------------------------------------------- | ------------------------------------------------- |
| manifest の YAML を書く                            | [Manifest (Shape Model)](/manifest)               |
| Shape の spec / outputs を確認する                 | [Shape Catalog](/reference/shapes)                |
| 20 default + 1 opt-in provider の対応 cloud と用途 | [Provider Plugins](/reference/providers)          |
| template shorthand の仕様                          | [Templates](/reference/templates)                 |
| `takosumi` CLI コマンド                            | [CLI Reference](/reference/cli)                   |
| `POST /v1/deployments` 等の HTTP API               | [Kernel HTTP API](/reference/kernel-http-api)     |
| kernel ↔ agent envelope                            | [Runtime-Agent API](/reference/runtime-agent-api) |
| `TAKOSUMI_*` 環境変数                              | [Environment Variables](/reference/env-vars)      |
| apply / destroy / rollback の挙動                  | [Lifecycle Protocol](/reference/lifecycle)        |
| operator が provider を wire する手順              | [Operator Bootstrap](/operator/bootstrap)         |
| 自前で provider / shape を増やす                   | [Extending Takosumi](/extending)                  |
