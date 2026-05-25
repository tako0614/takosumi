---
layout: home

hero:
  name: Takosumi
  text: AppSpec から Deployment へ
  tagline: アプリの構成ファイルからデプロイまでを一貫して管理する self-hostable PaaS。
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
      text: 読む順序
      link: ./getting-started/reading-paths
    - theme: alt
      text: AppSpec
      link: ./reference/app-spec

features:
  - title: 3 つの公開概念
    details: |
      AppSpec / Installation / Deployment だけで始められる。
  - title: AppSpec は小さく保つ
    details: |
      `.takosumi.yml` には component kind、kind-specific spec、publish/listen の接続を書く。
  - title: Deployment が履歴になる
    details: |
      apply の結果は append-only Deployment record として残り、rollback は retained Deployment を選ぶ。
  - title: 実行先は operator が選ぶ
    details: |
      AppSpec は portable な intent。operator は採用する catalog entry、implementation binding、policy で具体的な実行先を選ぶ。
---

## 最初に読むもの

| 読者                         | 最初のページ                                        |
| ---------------------------- | --------------------------------------------------- |
| 迷ったとき                   | [読む順序](./getting-started/reading-paths.md)      |
| 初めて読む                   | [コンセプト](./getting-started/concepts.md)         |
| まず動かしたい               | [クイックスタート](./getting-started/quickstart.md) |
| `.takosumi.yml` を書きたい   | [AppSpec リファレンス](./reference/app-spec.md)     |
| operator として運用したい    | [オペレーター](./operator/index.md)                 |
| provider / kind を増やしたい | [Takosumi を拡張する](./extending.md)               |

## 仕様の 3 層

Takosumi docs は core、official type catalog、operator distribution を分けて
読みます。AppSpec / Installation / Deployment の互換性は core spec、kind や
material の vocabulary は official type catalog、account-plane behavior は
operator distribution spec が持ちます。

| 仕様面                         | 読む入口                                                  | 何を決めるか                                                                            |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Takosumi core                  | [Core Specification](./reference/core-spec.md)            | AppSpec / Installation / Deployment、Installer API、publish/listen grammar。            |
| Takosumi official type catalog | [Type Catalog Specification](./reference/type-catalog.md) | kind descriptor、material contract、projection family、JSON-LD catalog metadata。       |
| Operator distribution          | [Takosumi Cloud bridge](./reference/takosumi-cloud.md)    | 別 docs で定義される account-plane、dashboard、billing、identity、deploy/admin facade。 |

Takosumi 本体仕様と Takosumi 公式型仕様は同じ docs site にありますが、章を分けて
読みます。Takosumi Cloud の具体仕様は `takosumi-cloud/docs/` に置き、この site
の [Takosumi Cloud](./reference/takosumi-cloud.md) はそこへ進む入口です。

## 3 つの公開概念

AppSpec は source に入る宣言ファイルです。Installer API は AppSpec source を
operator-supplied `spaceId` の文脈で評価し、Installation / Deployment record を
記録します。operator account plane は Space / account membership と
account-facing projection を所有します。

| 概念         | 意味                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| AppSpec      | source root の `.takosumi.yml`。アプリが欲しい runtime / resource / 接続を書く。                 |
| Installation | operator-supplied `spaceId` に scoped された AppSpec の core record。                            |
| Deployment   | 1 回の apply 結果。履歴、audit、rollback の根拠になる。rollback 自体は新 Deployment を作らない。 |

## よく参照するページ

| 目的                                                                 | ページ                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| core contract 全体を読む                                             | [Core Specification](./reference/core-spec.md)                              |
| `.takosumi.yml` を書く                                               | [AppSpec](./reference/app-spec.md)                                          |
| kind や material contract の vocabulary を見る                       | [Takosumi Official Type Catalog Specification](./reference/type-catalog.md) |
| operator surface を workload から consume する                       | [External publications](./reference/external-publications.md)               |
| Takosumi Cloud の account-plane API / facade を見る                  | [Takosumi Cloud](./reference/takosumi-cloud.md)                             |
| core / catalog / Cloud の境界を確認する                              | [Specification Boundaries](./reference/spec-boundaries.md)                  |
| install / deploy / rollback API を叩く                               | [Installer API](./reference/installer-api.md)                               |
| CLI の subcommand と env を見る                                      | [CLI](./reference/cli.md)                                                   |
| public app endpoint を adopted gateway/ingress descriptor で公開する | [HTTP Exposure](./reference/http-exposure.md)                               |
| build service / CI から prepared source を渡す                       | [Build service handoff](./reference/build-spec.md)                          |
| reference implementation を production 相当に起動するとき            | [Operator](./operator/index.md)                                             |
