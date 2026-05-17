# Takosumi

Self-hostable PaaS. **`.takosumi.yml` を読んで Space に Installation を作り、
apply ごとに Deployment を記録する、 完全独立の PaaS**。 あらゆる cloud /
docker / self-hosted 環境にデプロイできる。

📖 ドキュメント: <https://docs.takosumi.com/>

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
  --space space_personal
```

## 中核概念 (= public concept は 3 つだけ)

| 概念             | 表現                                              |
| ---------------- | ------------------------------------------------- |
| **AppSpec**      | `.takosumi.yml` (= source root の 1 ファイル)     |
| **Installation** | Space に入った AppSpec (= 所有 / 課金 / 現在状態) |
| **Deployment**   | 1 回の apply 結果 (= 履歴 / audit / rollback)    |

これ以上の名詞は基本的に仕様 surface に出さない。

## 設計の核

### Source-to-runtime model

`.takosumi.yml` を source root に置くだけ。 Takosumi は git URL / local path /
catalog id から source を取得し、 `component.build` を実行して artifact を作り、
provider plugin で runtime resource を materialize する。

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.notes
  name: Example Notes
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - /
    use:
      db:
        env: DATABASE_URL
  db:
    kind: postgres
```

### Component kind × Provider × Template

- **Component kind** (5 つ frozen): `worker` / `postgres` / `object-store` /
  `oidc` / `custom-domain`
- **Provider** (21 bundled): `@takos/cloudflare-workers` / `@takos/aws-fargate` /
  `@takos/gcp-cloud-run` / `@takos/selfhost-docker-compose` /
  `@takos/kubernetes-deployment` (worker) + `@takos/aws-s3` /
  `@takos/cloudflare-r2` / `@takos/gcp-gcs` / `@takos/selfhost-minio` /
  `@takos/selfhost-filesystem` (object-store) + ...
- **Template** (2 bundled): `selfhosted-single-vm@v1` /
  `web-app-on-cloudflare@v1`

provider 差し替えで AppSpec portable (S3 ↔ R2、 Cloudflare Workers ↔ AWS
Fargate 等)。

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
  --space space_personal \
  --remote https://kernel.example.com \
  --token $TAKOSUMI_INSTALLER_TOKEN
```

設定の優先順位は **flag > env > `~/.config/takosumi/config.json`** です。

## JSR packages

| Package                                                                             | 用途                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | turnkey: kernel + plugins + installer + cli を一括取得                |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | kernel only                                                           |
| [`jsr:@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | component kind catalog + provider + template + factories              |
| [`jsr:@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | .takosumi.yml parser + git fetch + deploy client                      |
| [`jsr:@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | runtime-agent (data plane: cloud SDK / OS executor)                   |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi` コマンド                                                   |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | 型契約 (上流)                                                         |

<sub>Note: `@takos/` JSR scope で公開される reference Takosumi distribution で
あり、 authority は publisher ではなく contract (`@takos/takosumi-contract`)
の側にある。 alternative publisher (例: `@example/takosumi-kernel`) は
spec-compatible — currently untested だが、 この scope に対する architectural
privilege は持たない。</sub>

## Workspace layout

```
takosumi/
├── packages/
│   ├── contract/        @takos/takosumi-contract       — AppSpec / Component / Provider の型契約
│   ├── runtime-agent/   @takos/takosumi-runtime-agent  — cloud SDK / OS executor (data plane)
│   ├── plugins/         @takos/takosumi-plugins        — component kinds / providers / templates / factories
│   ├── installer/       @takos/takosumi-installer      — .takosumi.yml parser / git fetch / deploy client
│   ├── kernel/          @takos/takosumi-kernel         — HTTP server + installer pipeline + storage + workers
│   ├── cli/             @takos/takosumi-cli            — `takosumi install` / `takosumi deploy` 等
│   └── all/             @takos/takosumi                — umbrella (上記 6 つを再公開)
├── docs/                                                — VitePress site (`deno task docs:dev`)
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
deno task publish:dry-run       # JSR package publish gate
```

per-package:

```bash
cd packages/cli && deno task test
cd packages/kernel && deno task db:migrate:dry-run
```

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks
the workspace, runs tests, performs a JSR dry-run, publishes the seven JSR
packages with GitHub OIDC, and builds/pushes the `takosumi` OCI image to GHCR.
Manual workflow runs stay dry-run unless the explicit `publish` input is set.

## Docs site (VitePress)

```bash
deno task docs:install   # cd docs && npm install (vitepress を pin)
deno task docs:dev       # http://localhost:5173 でプレビュー
deno task docs:build     # docs/.vitepress/dist へ build (CF Pages 公開対象)
```

publish: `master` への push で `.github/workflows/docs-deploy.yml` が Cloudflare
Pages project `takosumi-docs` にデプロイ。 custom domain は `docs.takosumi.com`
(Cloudflare Pages dashboard の Custom domains 設定で wire)。 CI には GitHub
secrets `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要。
