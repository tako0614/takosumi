# Takosumi

Self-hostable PaaS. **`.takosumi.yml` を読んで Space に Installation を作り、
apply ごとに Deployment を記録する、 完全独立の PaaS**。 あらゆる cloud / docker
/ self-hosted 環境にデプロイできる。

ドキュメント: <https://takosumi.com/docs/>

## Quickstart

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi server &                                  # in-process kernel
takosumi install --source ./                       # 現 dir の .takosumi.yml を install
```

remote kernel に投げる場合は URL/token を明示する:

```bash
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=https://kernel.example.com
takosumi install --source git:https://github.com/example/notes#main \
  --space space:personal
```

### AppSpec (= `.takosumi.yml`) の最小例

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
      - com.example.notes.db
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
```

`db` が `com.example.notes.db` namespace path に material (= host / port /
database / connectionString 等) を publish し、 `web` が同 path を `listen`
することで `DB_HOST` / `DB_PORT` / `DB_CONNECTIONSTRING` 等の env を受け取る。
component 間の接続は publish / listen で表す。

### Reference kernel に cloud provider を attach する (= 別 package import)

takosumi.com reference kernel を programmatic に起動する場合は provider
implementation adapter を **plain array** で渡す (= Vite plugin と同じ
pattern)。 cloud provider は **独立 package** として publish
されているので、必要な cloud だけ import する:

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  cloudflareR2ObjectStoreProvider,
  cloudflareWorkerProvider,
} from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({ accountId }),
    cloudflareR2ObjectStoreProvider({ accountId }),
    awsS3ObjectStoreProvider({ region }),
  ],
});
```

cloud credential / SDK code は runtime-agent の env または operator host
側に置く。 reference bootstrap で kernel に渡すのは `kindAliases` と provider
`plugins` で、provider factory には non-secret な provider selector / region /
account id や operator-owned lifecycle client を渡す。別の Takosumi-compatible
implementation は、同じ descriptor URI を別の registry / controller / adapter に
bind できる。

## 中核概念

| 概念             | 表現                                              |
| ---------------- | ------------------------------------------------- |
| **AppSpec**      | `.takosumi.yml` (= source root の 1 ファイル)     |
| **Installation** | Space に入った AppSpec (= 所有 / 課金 / 現在状態) |
| **Deployment**   | 1 回の apply 結果 (= 履歴 / audit / rollback)     |

Takosumi の公開 lifecycle はこの 3 entity を中心に説明する。

## 設計の核

### Source-to-runtime model

`.takosumi.yml` を source root に置くだけ。 Takosumi は git URL または prepared
source snapshot から source を取得し、provider lifecycle で runtime resource を
materialize する。build / prepare は kernel 外の build service / CI
が担当し、`source.kind: prepared` として渡す。

### Component kind × implementation binding

- **Component kind は operator が解決**: Takosumi AppSpec は `kind` を opaque
  string として扱う。`worker` / `postgres` などは operator の `kindAliases` で
  URI に解決される。
- **Reference descriptors は採用できる例**: `https://takosumi.com/kinds/v1/*` は
  takosumi.com reference descriptor の例。operator は `kindAliases`
  でそれを採用して もよいし、任意 domain の kind URI を使ってもよい。
- **JSON-LD descriptor が型**: kind URI に対応する descriptor が `spec` shape、
  outputs、publish / listen semantics を表す。
- **Plugin は reference 実装の手段**: cloud provider package
  (`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`)
  は takosumi.com reference kernel 向けに `KernelPlugin` factory を export
  する。 他の implementation は同じ descriptor URI を別の仕組みで materialize
  できる。

provider 差し替えで AppSpec portable (S3 ↔ R2、 Cloudflare Workers ↔ AWS Fargate
等)。

詳細は [`CONVENTIONS.md`](./CONVENTIONS.md) と [`docs/`](./docs/) 参照。

## CLI コマンド

```
takosumi install <source>                          # 新規 Installation 作成
takosumi install dry-run <source>                  # 検証 + 推定変更
takosumi deploy <installation-id>                  # 既存 Installation に apply
takosumi deploy dry-run <installation-id>          # upgrade の dry-run
takosumi rollback <installation-id> <deploy-id>    # 過去 Deployment に巻き戻し
takosumi installations list [--space <id>]         # Installation 一覧
takosumi installations show <id>                   # Installation 詳細
takosumi deployments list <installation-id>        # Deployment 履歴
takosumi deployments show <inst-id> <deploy-id>    # Deployment 詳細
takosumi server [--port 8080]                      # kernel HTTP server 起動
takosumi version
```

remote mode:

```bash
takosumi install --source git:https://github.com/example/notes#main \
  --space space:personal \
  --remote https://kernel.example.com \
  --token $TAKOSUMI_INSTALLER_TOKEN
```

設定の優先順位は **flag > env > `~/.config/takosumi/config.json`** です。

## JSR packages

core:

| Package                                                                             | 用途                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | turnkey: kernel + plugins + installer + cli を一括取得 |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | kernel only                                            |
| [`jsr:@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | reference kind descriptors + adapter helpers           |
| [`jsr:@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | .takosumi.yml parser + git fetch + deploy client       |
| [`jsr:@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | runtime-agent (data plane: cloud SDK / OS executor)    |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi` コマンド                                    |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | 型契約 (上流)                                          |

cloud provider packages (= 別 install、 必要な cloud だけ import):

| Package                                                                                             | 内容                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`jsr:@takos/takosumi-cloudflare-providers`](https://jsr.io/@takos/takosumi-cloudflare-providers)   | Cloudflare (Workers / R2 / DNS)                   |
| [`jsr:@takos/takosumi-aws-providers`](https://jsr.io/@takos/takosumi-aws-providers)                 | AWS (Fargate / S3 / RDS / Route53)                |
| [`jsr:@takos/takosumi-gcp-providers`](https://jsr.io/@takos/takosumi-gcp-providers)                 | GCP (Cloud Run / GCS / Cloud SQL)                 |
| [`jsr:@takos/takosumi-kubernetes-providers`](https://jsr.io/@takos/takosumi-kubernetes-providers)   | Kubernetes Deployment + Service                   |
| [`jsr:@takos/takosumi-deno-deploy-providers`](https://jsr.io/@takos/takosumi-deno-deploy-providers) | Deno Deploy                                       |
| [`jsr:@takos/takosumi-selfhost-providers`](https://jsr.io/@takos/takosumi-selfhost-providers)       | Self-host (docker / systemd / filesystem / minio) |

<sub>Note: `@takos/` JSR scope は current reference Takosumi distribution の
publish scope。互換性の authority は contract (`@takos/takosumi-contract`)
にあり、 alternative publisher (例: `@example/takosumi-kernel`) も同じ contract
に合わせられる。</sub>

## Workspace layout

```
takosumi/
├── packages/
│   ├── contract/                @takos/takosumi-contract        — AppSpec / Component / Provider の型契約
│   ├── runtime-agent/           @takos/takosumi-runtime-agent   — cloud SDK / OS executor (data plane)
│   ├── plugins/                 @takos/takosumi-plugins         — reference kind descriptors + adapter helpers
│   ├── installer/               @takos/takosumi-installer       — .takosumi.yml parser / git fetch / deploy client
│   ├── kernel/                  @takos/takosumi-kernel          — HTTP server + installer pipeline + storage + workers
│   ├── cli/                     @takos/takosumi-cli             — `takosumi install` / `takosumi deploy` 等
│   ├── cloudflare-providers/    @takos/takosumi-cloudflare-providers     — Cloudflare reference adapters
│   ├── aws-providers/           @takos/takosumi-aws-providers            — AWS reference adapters
│   ├── gcp-providers/           @takos/takosumi-gcp-providers            — GCP reference adapters
│   ├── kubernetes-providers/    @takos/takosumi-kubernetes-providers     — Kubernetes reference adapter
│   ├── deno-deploy-providers/   @takos/takosumi-deno-deploy-providers    — Deno Deploy reference adapter
│   ├── selfhost-providers/      @takos/takosumi-selfhost-providers       — Self-host reference adapters
│   └── all/                     @takos/takosumi                 — umbrella (core 6 つを再公開)
├── docs/                                                         — VitePress site (`deno task docs:dev`)
├── deploy/, fixtures/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract source は `packages/contract/` で、 公開 package は
[`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)。

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

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks
the workspace, runs tests, performs a JSR dry-run, publishes the 13 JSR packages
(core 7 + provider 6) with GitHub OIDC, and builds/pushes the `takosumi` OCI
image to GHCR. Manual workflow runs stay dry-run unless the explicit `publish`
input is set.

## Docs site (VitePress)

`takosumi/docs/` は VitePress site (`base: "/docs/"`)、 `takosumi/website/` は
Solid Start landing。 Wave M-G (= 2026-05-20) で両者と `takosumi/spec/contexts/`
を **単一 Cloudflare Pages project (`takosumi-website`)** に統合し、
`takosumi.com/` (landing) + `takosumi.com/docs/*` (docs) +
`takosumi.com/contexts/*` (JSON-LD vocab) を 1 つの Pages output で serve
する形に整理した (旧 `docs.takosumi.com` subdomain は廃止)。

```bash
deno task docs:install      # cd docs && npm install (vitepress を pin)
deno task docs:dev          # http://localhost:5173 で VitePress 単独プレビュー
deno task docs:build        # docs/.vitepress/dist へ build (内部 step)

deno task website:build     # landing + /docs/ + /contexts/ を website/.output/public/ に統合
deno task website:preview   # 同 Pages output を wrangler pages dev で確認
deno task website:deploy    # Cloudflare Pages project `takosumi-website` にデプロイ
```

publish: `master` への push で `.github/workflows/website-deploy.yml` が
Cloudflare Pages project `takosumi-website` にデプロイ。 custom domain は
`takosumi.com` / `www.takosumi.com` (Cloudflare Pages dashboard の Custom
domains 設定で wire)。 CI には GitHub secrets `CLOUDFLARE_API_TOKEN` と
`CLOUDFLARE_ACCOUNT_ID` が必要。 詳細は [`DEPLOY.md`](./DEPLOY.md) と
[`website/README.md`](./website/README.md) を参照。
