---
layout: home

hero:
  name: Takosumi
  text: Self-hostable PaaS toolkit
  tagline: Manifest 1 本で AWS / GCP / Cloudflare / Azure / Kubernetes / Docker / systemd へ deploy する、Deno-native な PaaS kernel + runtime-agent + CLI。
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
      portable な shape (`web-service@v1` / `database-postgres@v1` / `object-store@v1` / `custom-domain@v1` / `worker@v1`) を YAML / JSON-LD 互換 manifest で宣言。`takosumi deploy ./manifest.yml` で apply。project layout / `.takosumi/` convention は `takosumi-git` (sibling product) が提供する。
  - title: Multi-cloud + selfhost
    details: |
      20 個の default provider + 1 個の opt-in provider plugin で AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy / docker-compose / systemd / filesystem を同一 manifest spec で deploy。
  - title: Self-hostable, JSR-distributed
    details: |
      kernel と runtime-agent は JSR (`@takos/takosumi-kernel`, `@takos/takosumi-runtime-agent`) で配布。Deno 1 process で `takosumi server` を起動するだけで control plane + agent が立ち上がる。
  - title: Plugin / agent 分離
    details: |
      kernel は cloud SDK を直接呼ばない。runtime-agent が SigV4 / OAuth / kubectl / docker を握り、credential は agent 側にだけ存在する。control plane と data plane の責務が明確。
  - title: Artifact upload
    details: |
      OCI image URI だけでなく、`js-bundle` / `lambda-zip` / `static-bundle` / `wasm` の content-addressed artifact を `takosumi artifact push` で upload。manifest から hash で参照する。
  - title: Operator-friendly
    details: |
      `~/.takosumi/config.yml` で remote / token を保存、`takosumi completions <shell>` で shell completion、`takosumi server --detach` で systemd / docker template を出力。
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

詳細は [Concepts](/getting-started/concepts) を参照。

## 関連 docs

- [Quickstart](/getting-started/quickstart) — `takosumi server` 1 コマンドで dev
  → cloud deploy まで
- [Manifest (Shape Model)](/manifest) — compiled `resources[]` manifest /
  `${ref:...}` / `${secret-ref:...}` syntax
- [Architecture Overview](/reference/architecture/) — manifest / deployment core
  / execution / routing / artifact / operator boundary の設計 notes
- [Manifest Model](/reference/architecture/manifest-model) — Shape / Provider の
  closed manifest contract
- [Shape Catalog](/reference/shapes) — 5 shapes の spec / outputs / capabilities
- [Provider Plugins](/reference/providers) — 20 default providers + 1 opt-in
  provider の cloud × shape matrix
- [CLI Reference](/reference/cli) — 全 subcommand × flag × env
- [Operator Bootstrap](/operator/bootstrap) —
  `createTakosumiProductionProviders` の wire-in 例
