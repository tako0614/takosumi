# Takosumi

Self-hostable PaaS toolkit. **Manifest を投げてあらゆる cloud / docker /
self-hosted 環境にデプロイできる、完全独立の PaaS**。

📖 ドキュメント: <https://docs.takosumi.com/>

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi init ./manifest.yml             # 明示 path に manifest を作る
takosumi doctor --manifest ./manifest.yml # manifest / mode / token を確認
takosumi deploy ./manifest.yml           # local mode で apply
```

remote kernel に投げる場合は URL/token を明示する:

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788
takosumi server &
takosumi doctor --manifest ./manifest.yml
takosumi deploy ./manifest.yml
```

`.takosumi/manifest.yml` と `.takosumi/workflows/*.yml` の project layout は
`takosumi-git` の責務です。Takosumi kernel / CLI は project convention
を自動探索せず、 manifest を明示 path で受け取ります。

## Workspace layout

```
takosumi/
├── packages/
│   ├── contract/        @takos/takosumi-contract       — Shape / Provider / Template の型契約
│   ├── runtime-agent/   @takos/takosumi-runtime-agent  — cloud SDK / OS executor (data plane)
│   ├── plugins/         @takos/takosumi-plugins        — shapes / providers / templates / factories
│   ├── kernel/          @takos/takosumi-kernel         — HTTP server + apply pipeline + storage + workers
│   ├── cli/             @takos/takosumi-cli            — `takosumi deploy` 等のコマンド
│   └── all/             @takos/takosumi                — umbrella (上記 5 つを再公開)
├── docs/                                                — VitePress site (`deno task docs:dev`)
├── deploy/, fixtures/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract:
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) (別 repo,
型のみ)。

## JSR packages

| Package                                                                             | 用途                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | turnkey: kernel + plugins + cli を一括取得                            |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | kernel only (`deno run -A jsr:@takos/takosumi-kernel` で server 起動) |
| [`jsr:@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | shape catalog + provider + template + factories                       |
| [`jsr:@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | runtime-agent (data plane: cloud SDK / OS executor)                   |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi` コマンド                                                   |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | 型契約 (上流)                                                         |

## 設計の核

### Image-first model

manifest spec の `image` / `bundle` / `unit` は単なる URI 文字列。artifact
取得は **provider 側の責務**。Kubernetes が image pull するのと同じ方針。

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/me/api:v1.2.3 # provider が pull
      port: 8080
      scale: { min: 2, max: 10 }
```

### Shape × Provider × Template

- **Shape** (5 つ curated): `web-service@v1` / `object-store@v1` /
  `database-postgres@v1` / `custom-domain@v1` / `worker@v1`
- **Provider** (21 bundled, default-on 20 + opt-in 1): `@takos/aws-fargate` /
  `@takos/gcp-cloud-run` / `@takos/cloudflare-container` /
  `@takos/selfhost-docker-compose` / `@takos/kubernetes-deployment` /
  `@takos/selfhost-systemd` (web-service) + `@takos/aws-s3` /
  `@takos/cloudflare-r2` / `@takos/gcp-gcs` / `@takos/selfhost-minio` /
  `@takos/selfhost-filesystem` (object-store) + ...
- **Template** (2 bundled): `selfhosted-single-vm@v1` /
  `web-app-on-cloudflare@v1`

provider 差し替えで manifest portable (S3 ↔ R2、ECS ↔ docker-compose 等)。

詳細は [`CONVENTIONS.md`](./CONVENTIONS.md) と [`docs/`](./docs/) 参照。

## CLI コマンド

```
takosumi deploy <manifest>      # apply (manifest path required)
takosumi destroy <manifest>     # 逆順 destroy
takosumi status [<name>]        # 現在の resource state
takosumi plan <manifest>        # dry-run
takosumi doctor --manifest <path> # manifest / mode / token を表示
takosumi server [--port 8080]   # kernel HTTP server 起動
takosumi server --detach        # systemd / docker 等 supervisor template を出力して exit
takosumi migrate                # DB migrations
takosumi init [output]          # manifest scaffold (stdout when output is omitted)
takosumi completions <shell>    # bash / zsh / fish 用 shell completion 生成
takosumi version
```

remote mode:

```
takosumi deploy ./manifest.yml \
  --remote https://kernel.example.com \
  --token $TAKOSUMI_DEPLOY_TOKEN
```

設定の優先順位は **flag > env > `~/.takosumi/config.yml`** です。env は
`TAKOSUMI_REMOTE_URL` / `TAKOSUMI_DEPLOY_TOKEN`、deprecated alias は
`TAKOSUMI_KERNEL_URL` / `TAKOSUMI_TOKEN`。config file は次の YAML スキーマ:

```yaml
# ~/.takosumi/config.yml
remote_url: https://kernel.example.com
token: ${TAKOSUMI_DEPLOY_TOKEN}
```

shell completion install:

```bash
takosumi completions bash > ~/.bash_completion.d/takosumi
takosumi completions zsh  > ~/.zfunc/_takosumi
takosumi completions fish > ~/.config/fish/completions/takosumi.fish
```

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

### Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks
the workspace, runs tests, performs a JSR dry-run, publishes the six JSR
packages with GitHub OIDC, and builds/pushes the `takosumi` OCI image to GHCR.
Manual workflow runs stay dry-run unless the explicit `publish` input is set.

### Docs site (VitePress)

```bash
deno task docs:install   # cd docs && npm install (vitepress を pin)
deno task docs:dev       # http://localhost:5173 でプレビュー
deno task docs:build     # docs/.vitepress/dist へ build (CF Pages 公開対象)
```

publish: `master` への push で `.github/workflows/docs-deploy.yml` が Cloudflare
Pages project `takosumi-docs` にデプロイ。custom domain は `docs.takosumi.com`
(Cloudflare Pages dashboard の Custom domains 設定で wire)。CI には GitHub
secrets `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要。
