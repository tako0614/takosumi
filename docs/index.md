---
layout: home

hero:
  name: Takosumi
  text: Self-hostable PaaS
  tagline: source の `.takosumi.yml` を読んで、 Space に Installation を作り、 apply ごとに Deployment を記録する。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: Quickstart
      link: /getting-started/quickstart
    - theme: alt
      text: AppSpec を書く
      link: /reference/app-spec
    - theme: alt
      text: GitHub
      link: https://github.com/tako0614/takosumi

features:
  - title: AppSpec-driven
    details: |
      source root の 1 ファイル `.takosumi.yml` を書くだけで install + deploy + rollback まで動く。
  - title: 3 public concepts only
    details: |
      AppSpec / Installation / Deployment の 3 つだけで完結。 余計な名詞を作らない。
  - title: Multi-cloud + selfhost
    details: |
      Cloudflare Workers / AWS / GCP / Azure / Kubernetes / docker-compose / systemd / filesystem を同一 AppSpec で deploy。
  - title: Self-hostable, JSR-distributed
    details: |
      Deno 1 process で `takosumi server` を起動すれば control plane + agent が立ち上がる。
---

## 構成

Takosumi は **7 つの JSR package** で配布される:

| Package                                                                         | Role                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | AppSpec / Component / Provider 型契約                 |
| [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | HTTP server + installer pipeline + state DB + worker  |
| [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | component kind catalog + provider plugins + factories |
| [`@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | .takosumi.yml parser + git fetch + deploy client      |
| [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | cloud SDK / OS executor (data plane)                  |
| [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi install` / `takosumi deploy` 等の CLI       |
| [`@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | umbrella: 上記 6 つを再公開                           |

## はじめに読むもの

- [Quickstart](/getting-started/quickstart) — `takosumi server` 1 コマンドで dev
  → cloud install まで
- [Concepts](/getting-started/concepts) — AppSpec × Component × Kind モデル
- [AppSpec (`.takosumi.yml`)](/reference/app-spec) — envelope / components / use
  edge / build recipe / interfaces / permissions

## 目的別 lookup

| 目的                                | ページ                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| 設計 notes / layer 境界             | [Architecture Overview](/reference/architecture/)           |
| AppSpec / Installation / Deployment | [Manifest Model](/reference/architecture/manifest-model)    |
| 5 kind の spec / outputs            | [Component Kind Catalog](/reference/component-kind-catalog) |
| Installer 5 endpoint の wire spec   | [Installer API](/reference/installer-api)                   |
| 20 default + 1 opt-in provider      | [Provider Plugins](/reference/providers)                    |
| 全 subcommand × flag × env          | [CLI Reference](/reference/cli)                             |
| `createTakosumiProductionProviders` | [Operator Bootstrap](/operator/bootstrap)                   |

> 注: `@takos/` scope は Takos が publish する **reference distribution**
> であり、 authority は contract (`@takos/takosumi-contract`) 側にある。
> contract-compatible な alternative publisher も spec 上可能で、 architectural
> privilege は持たない。
