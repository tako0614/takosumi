# Concepts — AppSpec × Provider

> このページでわかること: AppSpec の component kind と provider implementation
> の関係を 5 分で理解する。

[Quickstart](/getting-started/quickstart) で `takosumi install` を 1
回通したあとに読むのがおすすめ。

---

## 3 つのレイヤー

```
┌────────────────────────────────────────────┐
│ AppSpec (.takosumi.yml)                    │
│  • components:     ← portable components   │
└────────────┬───────────────────────────────┘
             │ validate
             ▼
┌────────────────────────────────────────────┐
│ Component kind catalog                     │
│   curated 4 種:                            │
│     worker / postgres / object-store /     │
│     custom-domain                          │
│   + operator-defined kinds (JSON-LD)       │
└────────────┬───────────────────────────────┘
             │ selection (provider が implements)
             ▼
┌────────────────────────────────────────────┐
│ Provider plugins (operator が選ぶ実装)     │
│   @takos/aws-fargate, @takos/cloudflare-r2,│
│   @takos/selfhost-systemd, ...             │
└────────────────────────────────────────────┘
```

| Layer              | 何を表すか                                              | 誰が owner か            |
| ------------------ | ------------------------------------------------------- | ------------------------ |
| **Component kind** | AppSpec が宣言する portable な runtime / resource 型    | Takosumi (RFC で追加)    |
| **Provider**       | component kind を具体 substrate に materialize する実装 | operator / plugin author |

---

## Component kind

Component kind は portable な runtime / resource 型。 AppSpec が宣言するのは
「worker が欲しい」「postgres が欲しい」「object-store
が欲しい」という抽象だけで、どの cloud で動くかは AppSpec には書かない。

curated な公式 component kind は 4 種類 (= catalog は extensible で、 operator
は自前 domain で `.jsonld` を publish するだけで新 kind を 追加できる):

| Component kind  | 用途                                              |
| --------------- | ------------------------------------------------- |
| `worker`        | `js-bundle` artifact を edge / serverless で実行  |
| `postgres`      | managed PostgreSQL                                |
| `object-store`  | S3 互換の bucket                                  |
| `custom-domain` | DNS record + TLS termination で公開ドメインを構築 |

> `oidc` kind は takosumi-cloud に移動し、 worker が
> `listen: { operator.identity.oidc: { as: env } }` で受け取る namespace pub
> になりました (= takosumi core には JSON-LD も materializer もありません)。

各 component kind は次を持つ:

- **Spec** — AppSpec が書く field の型 (`build`, `routes`, `scopes` 等)
- **Outputs** — apply 後に確定する値 (`url`, `connectionString` 等)
- **Capabilities** — provider が optional で `versioning` / `auto-tls` 等を
  declare する

新しい component kind の追加は breaking change で、RFC が必要 (cf.
[Extending](/extending#新しい-component-kind-を-rfc-する))。

詳細: [Component Kind Catalog](/reference/component-kind-catalog)

---

## Provider

Provider は component kind の具体実装。 同じ `worker` / `postgres` /
`object-store` でも、Cloudflare / AWS / GCP / Kubernetes / self-host などの
provider がそれぞれ違う substrate で同じ kind を materialize する。

bundled provider は **20 default + 1 opt-in**、対応 cloud は AWS / GCP /
Cloudflare / Azure / Deno Deploy / Kubernetes + selfhost の 7 系統:

- **AWS** — `@takos/aws-{s3,fargate,rds,route53}`
- **GCP** — `@takos/gcp-{gcs,cloud-run,cloud-sql,cloud-dns}`
- **Cloudflare** — `@takos/cloudflare-{r2,container,workers,dns}`
- **Azure** — `@takos/azure-container-apps`
- **Deno Deploy** — `@takos/deno-deploy` (opt-in)
- **Kubernetes** — `@takos/kubernetes-deployment`
- **Selfhost** —
  `@takos/selfhost-{systemd,docker-compose,postgres,minio,filesystem,coredns}`

Provider selection は installer context と operator registry の責務。 AppSpec は
portable component kind と要求だけを書く。

詳細: [Provider Plugins](/reference/providers)

---

## Workflow placement

kernel は workflow / trigger / schedule の public route を持たない。 build は
AppSpec の `components.<name>.build` に最小 recipe として宣言し、外部 CI /
workflow runner は source ref を選んで installer API に渡す。

---

## Manifest 内での組み合わせ方

current public manifest は `.takosumi.yml` (= AppSpec):

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.my-app
  name: my-app
components:
  api:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes:
        - /api/*
```

(`routes:` は worker kind の `spec:` 内部 field — Wave J Component contract
minimization で AppSpec top-level からは削除されており、 worker materializer の
convention として `spec.routes` を読む)

component 間の構造的依存は **`publish` / `listen`** で書く。 文字列
interpolation は使わない。 producer 側が `publish: [<namespacePath>]` で
material を namespace registry に登録し、 consumer 側が
`listen: { <path>: { as, prefix? } }` で 受け取る。

```yaml
components:
  db:
    kind: postgres
    publish:
      - com.example.notes.db

  assets:
    kind: object-store
    publish:
      - com.example.notes.assets

  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    listen:
      com.example.notes.db:
        as: env
        prefix: DATABASE_
      com.example.notes.assets:
        as: env
        prefix: ASSETS_
```

`publish` / `listen` が DAG edge になり、 materializer output は env / mount /
target などの明示的な binding として渡される。 旧 `use:` edge / `${ref:...}` /
`${secret-ref:...}` の placeholder 文法は current AppSpec には存在しない。

---

## Architecture (kernel + runtime-agent) {#architecture-kernel--runtime-agent}

Takosumi は **2 process** から成る。

```
┌─ takosumi install/deploy ┐
│   CLI (local mode = in-process kernel,
│        remote mode = HTTP)
└─────────────┬───────────┘
              │ POST /v1/installations/*
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

- **kernel** は cloud SDK に直接触らない。`@takos/...` provider は runtime-agent
  への HTTP RPC として apply / describe / destroy を発行する。
- **runtime-agent** は cloud credential を持つ。 `@takos/aws-fargate` なら ECS
  API、 `@takos/selfhost-systemd` なら `systemctl enable --now` を実行する。
- dev では `takosumi server` 1 つで両方 1 process 内に起動する
  (`embedded agent`)。 production では別 host に分離して、 kernel 側に cloud
  credential が漏れない境界を作れる。

詳細: [Lifecycle Protocol](/reference/lifecycle),
[Operator Bootstrap](/operator/bootstrap)

---

## Where to look next

| 目的                                               | ページ                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- |
| AppSpec の YAML を書く                             | [AppSpec](/reference/app-spec)                              |
| component kind の spec / outputs を確認する        | [Component Kind Catalog](/reference/component-kind-catalog) |
| 20 default + 1 opt-in provider の対応 cloud と用途 | [Provider Plugins](/reference/providers)                    |
| `takosumi` CLI コマンド                            | [CLI Reference](/reference/cli)                             |
| `/v1/installations/*` の HTTP API                  | [Kernel HTTP API](/reference/kernel-http-api)               |
| kernel ↔ agent envelope                            | [Runtime-Agent API](/reference/runtime-agent-api)           |
| `TAKOSUMI_*` 環境変数                              | [Environment Variables](/reference/env-vars)                |
| apply / destroy / rollback の挙動                  | [Lifecycle Protocol](/reference/lifecycle)                  |
| operator が provider を wire する手順              | [Operator Bootstrap](/operator/bootstrap)                   |
| 自前で provider / component kind を増やす          | [Extending Takosumi](/extending)                            |
