---
layout: home

hero:
  name: Takosumi
  text: Manifest から Deployment へ
  tagline: アプリの構成ファイルからデプロイまでを一貫して管理する、セルフホスト可能な PaaS。
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
      text: Manifest
      link: ./reference/manifest

features:
  - title: 3 つの公開概念
    details: |
      Manifest、Installation、Deployment の 3 つだけで始められる。
  - title: Manifest は小さく保つ
    details: |
      1 つの YAML ファイルに DB・API・ワーカーの構成と接続を書くだけ。
  - title: Deployment が履歴になる
    details: |
      apply の結果は Deployment の記録として残り、rollback は保持された Deployment を選ぶ。
  - title: 実行先は operator が選ぶ
    details: |
      Manifest は移植可能な構成宣言。どのクラウドやランタイムで動かすかは operator が選ぶ。
---

## 最初に読むもの

| 読者                         | 最初のページ                                        |
| ---------------------------- | --------------------------------------------------- |
| 迷ったとき                   | [読む順序](./getting-started/reading-paths.md)      |
| 初めて読む                   | [コンセプト](./getting-started/concepts.md)         |
| まず動かしたい               | [クイックスタート](./getting-started/quickstart.md) |
| `.takosumi.yml` を書きたい   | [Manifest リファレンス](./reference/manifest.md)     |
| operator として運用したい    | [オペレーター](./operator/index.md)                 |
| provider / kind を増やしたい | [Takosumi を拡張する](./extending.md)               |

仕様の詳細は[仕様境界](./reference/spec-boundaries.md)を参照。

## 3 つの公開概念

Manifest / Installation / Deployment の詳細は
[コンセプト](./getting-started/concepts.md) を参照。

| 概念         | 意味                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| Manifest     | `.takosumi.yml` ファイル。アプリの構成と接続を宣言する。                    |
| Installation | Manifest を Space にインストールした記録。現在の状態を保持する。            |
| Deployment   | 1 回の apply 結果。履歴として残り、過去の Deployment に rollback できる。   |

## よく参照するページ

| 目的                                                                 | ページ                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Takosumi 仕様全体を読む                                              | [Takosumi core 仕様](./reference/core-spec.md)             |
| `.takosumi.yml` を書く                                               | [Manifest](./reference/manifest.md)                         |
| component の種類を調べる                                         | [対応 kind 一覧](./reference/type-catalog.md) |
| operator が提供する外部サービスを利用する                          | [外部サービス](./reference/external-publications.md)           |
| Takosumi Cloud のアカウント管理 API / facade を見る                  | [Takosumi Cloud](./reference/takosumi-cloud.md)            |
| Takosumi / 対応 kind 一覧 / Cloud の境界を確認する                   | [仕様境界](./reference/spec-boundaries.md)                 |
| install / deploy / rollback API を叩く                               | [Installer API](./reference/installer-api.md)              |
| CLI の subcommand と env を見る                                      | [CLI](./reference/cli.md)                                  |
| アプリを public URL で公開する                                       | [HTTP 公開](./reference/http-exposure.md)                  |
| CI やビルドサービスからデプロイする                                   | [Build service 境界](./reference/build-spec.md)            |
| Takosumi を本番環境で運用する                                        | [Operator](./operator/index.md)                            |
