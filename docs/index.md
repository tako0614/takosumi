---
layout: home

hero:
  name: Takosumi
  text: Self-hostable PaaS toolkit
  tagline: Manifest 1 本でどのクラウドにも、self-hostable な PaaS kernel。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: Quickstart
      link: /getting-started/quickstart
    - theme: alt
      text: Manifest を書く
      link: /manifest
    - theme: alt
      text: GitHub
      link: https://github.com/tako0614/takosumi

features:
  - title: Manifest-driven
    details: |
      portable な shape を YAML / JSON-LD 互換 manifest で宣言し、`takosumi deploy ./manifest.yml` で apply。
  - title: Multi-cloud + selfhost
    details: |
      AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy / docker-compose / systemd / filesystem を同一 manifest spec で deploy。
  - title: Self-hostable, JSR-distributed
    details: |
      Deno 1 process で `takosumi server` を起動すれば control plane + agent が立ち上がる。
  - title: Plugin / agent 分離
    details: |
      kernel は cloud SDK を呼ばず、 credential は runtime-agent 側にだけ存在する。
---

## 構成

Takosumi は **6 つの JSR package** で配布される:

| Package                                                                         | Role                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | Shape / Provider contract の型契約                      |
| [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | HTTP server + apply pipeline + state DB + worker daemon |
| [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | shape catalog + provider plugins + factories            |
| [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | cloud SDK / OS executor (data plane)                    |
| [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi deploy` / `takosumi server` 等の CLI          |
| [`@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | umbrella: 上記 5 つを再公開                             |

## はじめに読むもの

- [Quickstart](/getting-started/quickstart) — `takosumi server` 1 コマンドで dev
  → cloud deploy まで
- [Concepts](/getting-started/concepts) — Shape × Provider モデル
- [Manifest (Shape Model)](/manifest) — `resources[]` / `${ref:...}` /
  `${secret-ref:...}` syntax

## 目的別 lookup

| 目的                                | ページ                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| 設計 notes / layer 境界             | [Architecture Overview](/reference/architecture/)        |
| Shape / Provider の closed contract | [Manifest Model](/reference/architecture/manifest-model) |
| 5 shapes の spec / outputs          | [Shape Catalog](/reference/shapes)                       |
| 20 default + 1 opt-in provider      | [Provider Plugins](/reference/providers)                 |
| 全 subcommand × flag × env          | [CLI Reference](/reference/cli)                          |
| `createTakosumiProductionProviders` | [Operator Bootstrap](/operator/bootstrap)                |

> 注: `@takos/` scope は Takos が publish する **reference distribution**
> であり、 authority は contract (`@takos/takosumi-contract`) 側にある。
> contract-compatible な alternative publisher も spec 上可能で、 architectural
> privilege は持たない。
