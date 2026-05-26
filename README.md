# Takosumi

Takosumi is an operator-portable PaaS contract for installing source into a Space and recording each apply as a Deployment. Authors write one runtime/install manifest, `.takosumi.yml`; operators decide which external systems materialize each component kind.

ドキュメント: <https://takosumi.com/docs/>

## Quickstart

Run this from a source root that contains the `.takosumi.yml` shown below and the files referenced by its kind-specific `spec`.

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788 &  # local kernel
takosumi install dry-run \
  --remote http://127.0.0.1:8788 \
  --space space:personal \
  --source .
```

managed / remote operator に投げる場合は operator-issued token と Takosumi URL を明示する:

```bash
export TAKOSUMI_INSTALLER_TOKEN=<operator-issued-installer-token>
export TAKOSUMI_REMOTE_URL=https://kernel.example.com
takosumi install --source git:https://github.com/example/notes#v1.2.3 \
  --space space:personal
```

### Manifest (= `.takosumi.yml`) の最小例

この例は operator が Takosumi Kind Catalog の aliases (`postgres` / `worker`) を採用している前提です。別 operator では `kind` に operator-defined alias または URI を使います。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
```

`db` が local publication `db.connection` を公開し、`web` が同じ manifest 内で `listen` することで `DB_HOST` / `DB_PORT` / secretRef-mediated `DB_CONNECTIONSTRING` 等を runtime env として受け取る。component 間の接続は publish / listen で表す。Takosumi Cloud などの operator profile が提供する platform service は `from: operator.identity.oidc` のように `listen` から参照する。

## 中核概念

| 概念             | 表現                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| **manifest**     | `.takosumi.yml` (= source root の 1 ファイル)                                  |
| **Installation** | Space に入った manifest の core record (= current Deployment pointer / status) |
| **Deployment**   | 1 回の apply 結果 (= 履歴 / audit / rollback)                                  |

Takosumi の公開 lifecycle はこの 3 entity を中心に説明する。 Ownership、billing、permission scope、account-facing projection は operator account layer が保持する。

Kinds are operator-resolved names. The Takosumi Kind Catalog publishes descriptor vocabulary, and the reference implementation uses provider bindings. Public concepts are manifest / Installation / Deployment; the Installer API is the public HTTP surface for creating, updating, and rolling back them.

## 設計の核

### Source-to-runtime model

`.takosumi.yml` を source root に置くだけ。 Takosumi は git URL または prepared source snapshot から source を取得し、operator-selected binding で runtime resource を materialize する。build / prepare は Takosumi 外の build service / CI が担当し、`source.kind: prepared` として渡す。

### Component kind × binding

- **Component kind は operator が解決**: Takosumi manifest は `kind` を不透明な string として扱う。`worker` / `postgres` などは operator の `kindAliases` で URI に解決される。
- **Official type catalog の kind の定義は採用できる vocabulary**: `https://takosumi.com/kinds/v1/*` は Takosumi Kind Catalog の kind の定義の URI。operator は `kindAliases` でそれを採用してもよいし、任意 domain の kind URI を使ってもよい。
- **JSON-LD metadata は kind の定義**: kind URI に対応する metadata が `spec` input schema、outputs、publish / listen semantics を表す。
- **Provider / adapter package は reference Takosumi binding**: cloud provider package (`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy}-providers`) と external adapter package (`@takos/takosumi-plugin-<kind>-<backend>`) は reference Takosumi 向けに binding factory を export する。他の implementation は同じ kind URI を別の仕組みで materialize できる。

同じ kind / output type の overlapping subset を複数 provider が実装し、 operator evidence で互換性を確認できる場合、その subset の manifest は provider 差し替えに対して portable になる。provider-specific `spec` extension や credential 前提は自動的には portable にならない。

詳細は [`CONVENTIONS.md`](./CONVENTIONS.md) と [`docs/`](./docs/) 参照。

## CLI コマンド

```
takosumi install --space <id> --source <source>    # 新規 Installation 作成
takosumi install dry-run --space <id> --source <source>  # 検証 + 推定変更
takosumi deploy <installation-id> [--source <source>]     # 既存 Installation に apply
takosumi deploy dry-run <installation-id> [--source <source>]  # upgrade の dry-run
takosumi rollback <installation-id> <deploy-id>    # 過去 Deployment に巻き戻し
takosumi server [--port 8788]                      # kernel HTTP server 起動
takosumi version
```

remote mode:

```bash
takosumi install --source git:https://github.com/example/notes#v1.2.3 \
  --space space:personal \
  --remote https://kernel.example.com \
  --token $TAKOSUMI_INSTALLER_TOKEN
```

設定の優先順位は **flag > env > `~/.takosumi/config.yml`** です。

## JSR packages

core:

| Package                                                                             | 用途                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | turnkey: kernel + reference helpers + installer + cli |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | kernel only                                           |
| [`jsr:@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | official catalog helpers + reference adapter helpers  |
| [`jsr:@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | .takosumi.yml parser + git fetch + deploy client      |
| [`jsr:@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | lifecycle execution host (cloud SDK / OS executor)    |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi` コマンド                                   |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | manifest / Installer API wire types                   |

provider / adapter packages (= 別 install、必要な外部 system だけ import):

| Package                                                                                                                     | 内容                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [`jsr:@takos/takosumi-cloudflare-providers`](https://jsr.io/@takos/takosumi-cloudflare-providers)                           | Cloudflare (Workers / R2 / DNS)    |
| [`jsr:@takos/takosumi-aws-providers`](https://jsr.io/@takos/takosumi-aws-providers)                                         | AWS (Fargate / S3 / RDS / Route53) |
| [`jsr:@takos/takosumi-gcp-providers`](https://jsr.io/@takos/takosumi-gcp-providers)                                         | GCP (Cloud Run / GCS / Cloud SQL)  |
| [`jsr:@takos/takosumi-kubernetes-providers`](https://jsr.io/@takos/takosumi-kubernetes-providers)                           | Kubernetes Deployment + Service    |
| [`jsr:@takos/takosumi-deno-deploy-providers`](https://jsr.io/@takos/takosumi-deno-deploy-providers)                         | Deno Deploy                        |
| [`jsr:@takos/takosumi-plugin-web-service-docker-compose`](https://jsr.io/@takos/takosumi-plugin-web-service-docker-compose) | Docker Compose web-service adapter |
| [`jsr:@takos/takosumi-plugin-web-service-systemd`](https://jsr.io/@takos/takosumi-plugin-web-service-systemd)               | systemd web-service adapter        |
| [`jsr:@takos/takosumi-plugin-object-store-minio`](https://jsr.io/@takos/takosumi-plugin-object-store-minio)                 | MinIO object-store adapter         |
| [`jsr:@takos/takosumi-plugin-object-store-filesystem`](https://jsr.io/@takos/takosumi-plugin-object-store-filesystem)       | filesystem object-store adapter    |
| [`jsr:@takos/takosumi-plugin-postgres-docker`](https://jsr.io/@takos/takosumi-plugin-postgres-docker)                       | Docker Postgres adapter            |
| [`jsr:@takos/takosumi-plugin-gateway-coredns`](https://jsr.io/@takos/takosumi-plugin-gateway-coredns)                       | CoreDNS gateway adapter            |

<sub>Note: `@takos/` JSR scope は current reference Takosumi distribution の publish scope。互換性の authority は contract (`@takos/takosumi-contract`) にあり、 alternative publisher (例: `@example/takosumi-kernel`) も同じ contract に合わせられる。</sub>

## Workspace layout

```
takosumi/
├── packages/
│   ├── contract/                @takos/takosumi-contract        — manifest / Installer API wire types
│   ├── runtime-agent/           @takos/takosumi-runtime-agent   — lifecycle execution host (cloud SDK / OS executor)
│   ├── plugins/                 @takos/takosumi-plugins         — official catalog helpers + reference adapter helpers
│   ├── installer/               @takos/takosumi-installer       — .takosumi.yml parser / git fetch helpers / deploy client
│   ├── kernel/                  @takos/takosumi-kernel          — HTTP server + Installer API pipeline + storage + workers
│   ├── cli/                     @takos/takosumi-cli             — `takosumi install` / `takosumi deploy` 等
│   ├── cloudflare-providers/    @takos/takosumi-cloudflare-providers     — Cloudflare provider bindings
│   ├── aws-providers/           @takos/takosumi-aws-providers            — AWS provider bindings
│   ├── gcp-providers/           @takos/takosumi-gcp-providers            — GCP provider bindings
│   ├── kubernetes-providers/    @takos/takosumi-kubernetes-providers     — Kubernetes provider binding
│   ├── deno-deploy-providers/   @takos/takosumi-deno-deploy-providers    — Deno Deploy provider binding
│   ├── plugin-web-service-docker-compose/    @takos/takosumi-plugin-web-service-docker-compose
│   ├── plugin-web-service-systemd/           @takos/takosumi-plugin-web-service-systemd
│   ├── plugin-object-store-minio/            @takos/takosumi-plugin-object-store-minio
│   ├── plugin-object-store-filesystem/       @takos/takosumi-plugin-object-store-filesystem
│   ├── plugin-postgres-docker/               @takos/takosumi-plugin-postgres-docker
│   ├── plugin-gateway-coredns/               @takos/takosumi-plugin-gateway-coredns
│   └── all/                     @takos/takosumi                 — umbrella (core packages + reference helpers)
├── docs/                                                         — VitePress site (`deno task docs:dev`)
├── deploy/, fixtures/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract source は `packages/contract/` で、公開 package は [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)。

## Development

```bash
deno test --allow-all           # workspace 全 test
deno task check                 # 全 package type-check
deno task fmt:check
deno task lint
deno task lint:json-ld          # JSON-LD reference descriptor lint
deno task publish:dry-run       # JSR package publish gate
```

per-package:

```bash
cd packages/cli && deno task test
cd packages/kernel && deno task db:migrate:dry-run
```

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks the workspace, runs tests, performs a JSR dry-run, publishes the 18 JSR packages (core/runtime/tooling 6 + official helper 1 + provider/adapter 11) with GitHub OIDC, and builds/pushes the `takosumi` OCI image to GHCR. Manual workflow runs stay dry-run unless the explicit `publish` input is set.

## Docs site (VitePress)

`takosumi/docs/` は VitePress site (`base: "/docs/"`)、 `takosumi/website/` は Solid Start landing です。公開 Pages output は landing / docs / reference descriptor contexts を同じ `takosumi.com` 配下にまとめます。

```bash
deno task docs:install      # cd docs && npm install (vitepress を pin)
deno task docs:dev          # http://localhost:5173 で VitePress 単独プレビュー
deno task docs:build        # docs/.vitepress/dist へ build (内部 step)

deno task website:build     # landing + /docs/ + /contexts/ を website/.output/public/ に統合
deno task website:preview   # 同 Pages output を wrangler pages dev で確認
deno task website:deploy    # Cloudflare Pages project `takosumi-website` にデプロイ
```

publish: `master` への push で `.github/workflows/website-deploy.yml` が Cloudflare Pages project `takosumi-website` にデプロイします。詳細は [`DEPLOY.md`](./DEPLOY.md) と [`website/README.md`](./website/README.md) を参照。
