---
layout: home

hero:
  name: Takosumi
  text: セルフホスト可能な PaaS
  tagline: source の `.takosumi.yml` を読んで、 Space に Installation を作り、 apply ごとに Deployment を記録する。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: クイックスタート
      link: /getting-started/quickstart
    - theme: alt
      text: AppSpec を書く
      link: /reference/app-spec
    - theme: alt
      text: GitHub
      link: https://github.com/tako0614/takosumi

features:
  - title: AppSpec ドリブン
    details: |
      source root の 1 ファイル `.takosumi.yml` を書くだけで install + deploy + rollback まで動く。
  - title: 公開コンセプトは 3 つだけ
    details: |
      AppSpec / Installation / Deployment の 3 つだけで完結。 余計な名詞を作らない。
  - title: マルチクラウド + セルフホスト
    details: |
      Cloudflare Workers / AWS / GCP / Azure / Kubernetes / docker-compose / systemd / filesystem を同一 AppSpec で deploy。
  - title: セルフホスト可能、 JSR 配布
    details: |
      Deno 1 process で `takosumi server` を起動すれば control plane + agent が立ち上がる。
---

## 構成

Takosumi は **core 6 package + umbrella + cloud provider 6 別 package = 計 13
package** で配布される (cloud provider package は operator が必要な cloud
だけを別 install する)。

### Core (6 package + umbrella)

| Package                                                                         | Role                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | AppSpec / Component / Provider 型契約                          |
| [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | HTTP server + installer pipeline + state DB + worker           |
| [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | component kind catalog + materializer host + factories         |
| [`@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | .takosumi.yml parser + git fetch + deploy client               |
| [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | cloud SDK / OS executor (data plane)                           |
| [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi install` / `takosumi deploy` 等の CLI                |
| [`@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | umbrella: 上記 core 6 つを再公開 (cloud provider は別 install) |

> 注: `@takos/` scope は Takos が publish する **reference distribution**
> であり、 authority は contract (`@takos/takosumi-contract`) 側にある。
> contract-compatible な alternative publisher も spec 上可能で、 architectural
> privilege は持たない。

### Cloud provider (6 別 package)

operator は必要な cloud だけを別 install する。 詳細は
[Provider Plugins](./reference/providers.md) 参照。

| Package                                                                                         | Role                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [`@takos/takosumi-cloudflare-providers`](https://jsr.io/@takos/takosumi-cloudflare-providers)   | Cloudflare (Workers / R2 / DNS) 用 factories |
| [`@takos/takosumi-aws-providers`](https://jsr.io/@takos/takosumi-aws-providers)                 | AWS (Fargate / S3 / RDS / Route53) factories |
| [`@takos/takosumi-gcp-providers`](https://jsr.io/@takos/takosumi-gcp-providers)                 | GCP (Cloud Run / GCS / Cloud SQL) factories  |
| [`@takos/takosumi-kubernetes-providers`](https://jsr.io/@takos/takosumi-kubernetes-providers)   | Kubernetes Deployment + Service factory      |
| [`@takos/takosumi-deno-deploy-providers`](https://jsr.io/@takos/takosumi-deno-deploy-providers) | Deno Deploy factory                          |
| [`@takos/takosumi-selfhost-providers`](https://jsr.io/@takos/takosumi-selfhost-providers)       | Self-host (docker / systemd / filesystem) 用 |

## はじめに読むもの

- [Quickstart](/getting-started/quickstart) — `takosumi server` 1 コマンドで dev
  → cloud install まで
- [Concepts](/getting-started/concepts) — AppSpec × Component × Kind モデル
- [AppSpec (`.takosumi.yml`)](./reference/app-spec.md) — envelope / components /
  publish / listen / build recipe

## 目的別 lookup

| 目的                                            | ページ                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| 設計 notes / layer 境界                         | [Architecture Overview](./reference/architecture/index.md)  |
| AppSpec / Installation / Deployment             | [Manifest](./reference/manifest.md#data-model)              |
| curated 4 kind + extensible の spec / outputs   | [Kind Catalog](./reference/kind-catalog.md#component-kinds) |
| Installer 5 endpoint の wire spec               | [Installer API](./reference/installer-api.md)               |
| 20 default + 1 opt-in provider (詳細 list) [^1] | [Provider Plugins](./reference/providers.md)                |
| 全 subcommand × flag × env                      | [CLI Reference](./reference/cli.md)                         |
| `createPaaSApp({ plugins })` plain-array attach | [Operator Bootstrap](/operator/bootstrap)                   |

[^1]: 内訳: AWS 4 (`s3` / `fargate` / `rds` / `route53`) + GCP 4 (`gcs` /
    `cloud-run` / `cloud-sql` / `cloud-dns`) + Cloudflare 4 (`r2` / `container`
    / `workers` / `dns`) + Azure 1 (`container-apps`) + Kubernetes 1
    (`deployment`) + Selfhost 6 (`filesystem` / `minio` / `docker-compose` /
    `systemd` / `postgres` / `coredns`) = **20 default**、 Deno Deploy 1
    (`deno-deploy`、 opt-in / 個別 import) = **計 21**。 詳細は
    [Provider Plugins § Bundled provider カタログ](./reference/providers.md#bundled-provider-catalog)
    を参照。
