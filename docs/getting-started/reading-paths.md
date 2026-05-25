# 読む順序 {#reading-paths}

## First-time evaluator

1. [コンセプト](./concepts.md)
2. [Specification Boundaries](../reference/spec-boundaries.md)
3. [Takosumi Core Specification](../reference/core-spec.md)
4. [AppSpec](../reference/app-spec.md)
5. [クイックスタート](./quickstart.md)
6. 公開 contract の範囲を確認したくなったら
   [リファレンス索引](../reference/index.md)

## AppSpec を書く人 {#appspec-authors}

まず読む:

1. [コンセプト](./concepts.md)
2. [クイックスタート](./quickstart.md)
3. [AppSpec](../reference/app-spec.md)
4. [Takosumi Core Specification](../reference/core-spec.md)
5. [Specification Boundaries](../reference/spec-boundaries.md)

必要になったら読む:

- kind や material contract の concrete vocabulary が必要になったら
  [Takosumi Official Type Catalog Specification](../reference/type-catalog.md)
- operator提供materialを workload から受け取るときは
  [External publications](../reference/external-publications.md)
- Takosumi Cloud が所有する workload publication path、deploy facade、 dashboard
  API など account-plane/admin surface が必要になったら
  [Takosumi Cloud](../reference/takosumi-cloud.md) から
  [Takosumi Cloud Specification](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/spec.md)
- public app endpoint を出すときは
  [HTTP Exposure](../reference/http-exposure.md)
- build が必要になったら [Build service handoff](../reference/build-spec.md)
- 操作コマンドが必要になったら [CLI](../reference/cli.md)
- automation / integration が必要になったら
  [Installer API](../reference/installer-api.md)

## Reference kernel operator として動かす人 {#reference-kernel-operators}

1. [コンセプト](./concepts.md)
2. [オペレーター](../operator/index.md)
3. [Operator Bootstrap](../operator/bootstrap.md)
4. [セルフホスト運用](../operator/self-host.md)
5. [runtime-agent 分離](../operator/runtime-agent.md)
6. [Environment Variables](../reference/env-vars.md)
7. [Readiness Probes](../reference/readiness-probes.md)
8. 必要な詳細を引くときは [リファレンス索引](../reference/index.md)

## Takosumi Cloud operator / account-plane を読む人 {#cloud-operators}

1. [Takosumi Cloud](../reference/takosumi-cloud.md)
2. [Takosumi Cloud docs index](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/index.md)
3. [Takosumi Cloud Specification](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/spec.md)
4. [Takosumi Cloud Accounts service wire details](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/accounts-service.md)

## Provider / extension を作る人 {#provider-extension-authors}

1. [Takosumi を拡張する](../extending.md)
2. [Specification Boundaries](../reference/spec-boundaries.md)
3. [Takosumi Official Type Catalog Specification](../reference/type-catalog.md)
4. [AppSpec](../reference/app-spec.md)
5. [Provider Implementations](../reference/providers.md) — adopted descriptor を
   reference implementation binding へ接続する実装資料
6. [Connector Guide](../reference/connector-contract.md)
7. [Reference Runtime-Agent Execution Surface](../reference/runtime-agent-api.md)
8. reference kernel の adapter 配線を実装するときだけ
   [Reference Adapter Loading](../reference/plugin-loading.md)

## Core contributor {#core-contributors}

1. [Specification Boundaries](../reference/spec-boundaries.md)
2. [Takosumi Core Specification](../reference/core-spec.md)
3. [AppSpec](../reference/app-spec.md)
4. [Installer API](../reference/installer-api.md)
5. [内部設計の概要](../reference/architecture/index.md)
6. [Reference Kernel Route Inventory](../reference/kernel-http-api.md)
7. [Lifecycle Protocol](../reference/lifecycle.md)
8. 必要に応じて [RFC / design record](../rfc/0001-kernel-kind-agnostic.md)
