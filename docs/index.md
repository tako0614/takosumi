---
layout: home

hero:
  name: Takosumi
  text: AppSpec から Deployment へ
  tagline: source root の `.takosumi.yml` を読み、Space に Installation を作り、apply ごとに Deployment を記録する self-hostable PaaS。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: クイックスタート
      link: /getting-started/quickstart
    - theme: alt
      text: 読む順序
      link: /getting-started/reading-paths
    - theme: alt
      text: AppSpec
      link: /reference/app-spec

features:
  - title: 3 つの公開概念
    details: |
      Takosumi の読み始めは AppSpec / Installation / Deployment だけで十分です。
  - title: AppSpec は小さく保つ
    details: |
      `.takosumi.yml` には runtime、resource、component 間接続の intent を書きます。
  - title: source を固定して apply する
    details: |
      git source または prepared source snapshot を Installer API に渡し、Deployment として記録します。
  - title: 実行先は operator が選ぶ
    details: |
      AppSpec は portable な intent です。kind の意味と実行先は operator distribution が解決します。
---

## 何をするものか

Takosumi は AppSpec を Installation として Space に入れ、apply / rollback
の結果を Deployment として記録する installer kernel です。

アプリを書く人は source root に `.takosumi.yml` を置きます。CLI や automation は
その source を Installer API に渡します。Takosumi は AppSpec を検証し、component
kind と namespace 接続を解決し、実行結果を Deployment history として残します。

account、billing、OIDC issuer、customer onboarding UI は operator account-plane
が接続します。Takosumi kernel docs は AppSpec、Installation、Deployment、
Installer API、operator が起動する reference implementation の境界を扱います。

## 最初に読むもの

| 読者                         | 最初のページ                                    |
| ---------------------------- | ----------------------------------------------- |
| まず動かしたい               | [クイックスタート](/getting-started/quickstart) |
| 全体像を掴みたい             | [コンセプト](/getting-started/concepts)         |
| 役割別に読みたい             | [読む順序](/getting-started/reading-paths)      |
| `.takosumi.yml` を書きたい   | [AppSpec リファレンス](/reference/app-spec)     |
| operator として運用したい    | [オペレーター](/operator/)                      |
| provider / kind を増やしたい | [Takosumi を拡張する](/extending)               |

## 3 つの公開概念

| 概念         | 意味                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| AppSpec      | source root の `.takosumi.yml`。アプリが欲しい runtime / resource / 接続を書く。  |
| Installation | Space に入った AppSpec。Space は operator/account-plane が所有する install 境界。 |
| Deployment   | 1 回の apply / rollback の結果。履歴、audit、rollback の根拠になる。              |

この 3 つを掴んだら、次は [AppSpec](/reference/app-spec) と
[Installer API](/reference/installer-api) を読めば public contract を追えます。

## よく参照するページ

| 目的                                   | ページ                                               |
| -------------------------------------- | ---------------------------------------------------- |
| `.takosumi.yml` を書く                 | [AppSpec](/reference/app-spec)                       |
| source build / prepare の分担を見る    | [Build service handoff](/reference/build-spec)       |
| install / deploy / rollback API を叩く | [Installer API](/reference/installer-api)            |
| CLI の subcommand と env を見る        | [CLI](/reference/cli)                                |
| kind descriptor の例を見る             | [Kind Descriptor Examples](/reference/kind-registry) |
| provider 実装の attach / 選択を見る    | [Provider Implementations](/reference/providers)     |
| production 起動の前提を見る            | [Operator](/operator/)                               |
