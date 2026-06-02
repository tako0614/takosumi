---
layout: home

hero:
  name: Takosumi
  text: Source から Deployment へ
  tagline: manifestless な Source install/deploy ledger。実行先と PlatformService inventory は operator が所有する。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: コンセプト
      link: ./getting-started/concepts
    - theme: alt
      text: クイックスタート
      link: ./getting-started/quickstart
    - theme: alt
      text: Installer API
      link: ./reference/installer-api
    - theme: alt
      text: 仕様境界
      link: ./reference/spec-boundaries

features:
  - title: 4 つの公開概念
    details: |
      Source、Installation、Deployment、PlatformService に閉じる。
  - title: manifestless v1
    details: |
      repo に Takosumi 専用 source metadata file や metadata field を要求しない。
  - title: Deployment が履歴になる
    details: |
      apply の結果は Deployment として残り、rollback は current pointer を戻す。
  - title: OpenTofu は operator 側
    details: |
      OpenTofu state と provider credential は operator distribution が持つ。
---

## 最初に読むもの

| 読者 | 最初のページ |
| --- | --- |
| 初めて読む | [コンセプト](./getting-started/concepts.md) |
| まず動かしたい | [クイックスタート](./getting-started/quickstart.md) |
| 目的別に読みたい | [読む順序](./getting-started/reading-paths.md) |
| API を実装したい | [Installer API](./reference/installer-api.md) |
| operator として運用したい | [オペレーター](./operator/index.md) |

## 4 つの公開概念

| 概念 | 意味 |
| --- | --- |
| Source | `git` / `prepared` / `local` source と resolved identity。 |
| Installation | Space に install された source record。 |
| Deployment | 1 回の apply 結果。plan snapshot、binding snapshot、outputs を持つ。 |
| PlatformService | operator inventory から選択される DB / OIDC / bucket / queue などの service。 |

## よく参照するページ

| 目的 | ページ |
| --- | --- |
| Takosumi v1 を読む | [Takosumi v1](./reference/takosumi-v1.md) |
| install / deploy / rollback API を叩く | [Installer API](./reference/installer-api.md) |
| PlatformService inventory を理解する | [プラットフォームサービス](./reference/platform-services.md) |
| Takosumi / operator surface の境界を確認する | [仕様境界](./reference/spec-boundaries.md) |
| CLI の subcommand と env を見る | [CLI](./reference/cli.md) |
| CI やビルドサービスからデプロイする | [Build service 境界](./reference/build-spec.md) |
| Takosumi を本番環境で運用する | [Operator](./operator/index.md) |
