# Takosumi

Self-hostable PaaS toolkit. **Manifest を投げてあらゆる cloud / docker /
self-hosted 環境にデプロイできる、完全独立の PaaS**。

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi init my-app.yml --template selfhosted-single-vm
takosumi server &                # kernel HTTP server を起動
takosumi deploy my-app.yml       # apply
```

## Workspace layout

```
takosumi/
├── packages/
│   ├── kernel/    @takos/takosumi-kernel  — HTTP server + apply pipeline + storage + workers
│   ├── plugins/   @takos/takosumi-plugins — shapes / providers / templates / factories
│   ├── cli/       @takos/takosumi-cli     — `takosumi deploy` 等のコマンド
│   └── all/       @takos/takosumi         — umbrella (上記 3 つを再公開)
├── docs/, deploy/, fixtures/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract:
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) (別 repo,
型のみ)。

## JSR packages

| Package                                                                   | 用途                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                   | turnkey: kernel + plugins + cli を一括取得                            |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)     | kernel only (`deno run -A jsr:@takos/takosumi-kernel` で server 起動) |
| [`jsr:@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)   | shape catalog + provider + template + factories                       |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)           | `takosumi` コマンド                                                   |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) | 型契約 (上流)                                                         |

## 設計の核

### Image-first model

manifest spec の `image` / `bundle` / `unit` は単なる URI 文字列。artifact
取得は **provider 側の責務**。Kubernetes が image pull するのと同じ方針。

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: aws-fargate
    spec:
      image: ghcr.io/me/api:v1.2.3 # provider が pull
      port: 8080
      scale: { min: 2, max: 10 }
```

### Shape × Provider × Template

- **Shape** (4 つ curated): `web-service@v1` / `object-store@v1` /
  `database-postgres@v1` / `custom-domain@v1`
- **Provider** (18 bundled): aws-fargate / cloud-run / cloudflare-container /
  docker-compose / k3s-deployment / systemd-unit (web-service) + aws-s3 /
  cloudflare-r2 / gcp-gcs / minio / filesystem (object-store) + ...
- **Template** (2 bundled): `selfhosted-single-vm@v1` /
  `web-app-on-cloudflare@v1`

provider 差し替えで manifest portable (S3 ↔ R2、ECS ↔ docker-compose 等)。

詳細は [`CONVENTIONS.md`](./CONVENTIONS.md) と [`docs/`](./docs/) 参照。

## CLI コマンド

```
takosumi deploy <manifest>      # apply (local mode in-process / remote mode HTTP)
takosumi destroy <manifest>     # 逆順 destroy
takosumi status [<name>]        # 現在の resource state
takosumi plan <manifest>        # dry-run
takosumi server [--port 8080]   # kernel HTTP server 起動
takosumi migrate                # DB migrations
takosumi init [--template ...]  # manifest scaffold
takosumi version
```

remote mode:

```
takosumi deploy ./manifest.yml \
  --remote https://kernel.example.com \
  --token $TAKOSUMI_TOKEN
```

env (`TAKOSUMI_KERNEL_URL`, `TAKOSUMI_TOKEN`) でも設定可能。

## Development

```bash
deno test --allow-all           # workspace 全 test
deno task check                 # 全 package type-check
deno task fmt:check
deno task lint
```

per-package:

```bash
cd packages/cli && deno task test
cd packages/kernel && deno task db:migrate:dry-run
```
