---
layout: home

hero:
  name: Takosumi
  text: AppSpec から runtime へ
  tagline: source root の `.takosumi.yml` を読み、Space に Installation を作り、apply ごとに Deployment を記録する self-hostable PaaS。
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: クイックスタート
      link: /getting-started/quickstart
    - theme: alt
      text: コンセプト
      link: /getting-started/concepts
    - theme: alt
      text: AppSpec
      link: /reference/app-spec

features:
  - title: AppSpec は小さく保つ
    details: |
      `.takosumi.yml` は runtime、resource、component 間接続を書く。source build が必要な operator は build-service handoff で prepared source を作る。
  - title: 3 つの公開概念
    details: |
      AppSpec / Installation / Deployment を公開概念の中心に置き、内部 ledger や実装詳細を入口に出さない。
  - title: operator が実装を選ぶ
    details: |
      AppSpec は portable な intent を書く。どの cloud / on-prem provider で materialize するかは operator が選ぶ。
  - title: self-hostable kernel
    details: |
      dev では `takosumi server` で kernel + embedded runtime-agent を起動できる。production では agent を分離できる。
---

## 最初に読むもの

1. [クイックスタート](/getting-started/quickstart) — `.takosumi.yml` を置いて
   first install まで通す。
2. [コンセプト](/getting-started/concepts) — AppSpec、Component、Kind、
   Materializer、publish/listen の関係を読む。
3. [AppSpec リファレンス](/reference/app-spec) — `.takosumi.yml` の root fields
   と validation rule を確認する。
4. 必要な場合: [Build service handoff](/reference/build-spec) — prepared source
   を作る operator build-service convention を確認する。

## 何をするものか

Takosumi は source-to-runtime の installer kernel です。ユーザーは source root
に AppSpec を置きます。installer client は git source または prepared source
snapshot を Installer API に渡します。operator は provider implementation と
runtime-agent を用意します。kernel は AppSpec を検証し、Space context で kind /
provider decision を解決して、Installation を Space に作り、apply / rollback の
たびに Deployment record を残します。

Takosumi docs は kernel と installer contract に集中します。account、billing、
OIDC issuer、customer onboarding UI は operator account-plane が接続します。

## よく参照するページ

| 目的                                   | ページ                                           |
| -------------------------------------- | ------------------------------------------------ |
| `.takosumi.yml` を書く                 | [AppSpec](/reference/app-spec)                   |
| prepared source を作る                 | [Build service handoff](/reference/build-spec)   |
| install / deploy / rollback API を叩く | [Installer API](/reference/installer-api)        |
| CLI の subcommand と env を見る        | [CLI](/reference/cli)                            |
| provider 実装の attach / 選択を見る    | [Provider Implementations](/reference/providers) |
| production 起動の前提を見る            | [Operator](/operator/)                           |
| 内部設計を追う                         | [内部設計の概要](/reference/architecture/)       |
