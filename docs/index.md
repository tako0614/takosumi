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
  - title: 1 ファイルで宣言
    details: |
      AppSpec は source root の `.takosumi.yml` だけ。runtime、resource、component 間接続を同じファイルで表す。
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
3. [AppSpec リファレンス](/reference/app-spec) — `.takosumi.yml` の全体 shape
   と validation rule を確認する。

## 何をするものか

Takosumi は source-to-runtime の installer kernel です。ユーザーは source root
に AppSpec を置き、operator は provider plugin と runtime-agent を用意します。
kernel は AppSpec を検証し、Installation を Space に作り、apply / rollback の
たびに Deployment record を残します。

Takosumi kernel は account、billing、OIDC issuer、customer onboarding UI を所有
しません。それらは operator account-plane の責務です。Takosumi docs では kernel
と installer contract を説明し、managed offering 固有の話は扱いません。

## よく参照するページ

| 目的 | ページ |
| --- | --- |
| `.takosumi.yml` を書く | [AppSpec](/reference/app-spec) |
| install / deploy / rollback API を叩く | [Installer API](/reference/installer-api) |
| CLI の subcommand と env を見る | [CLI](/reference/cli) |
| provider plugin の attach / 選択を見る | [Provider Plugins](/reference/providers) |
| production 起動の前提を見る | [Operator](/operator/) |
| 内部設計を追う | [Architecture Overview](/reference/architecture/) |
