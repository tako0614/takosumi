# 読む順序 {#reading-paths}

## 初めて読む人 {#first-time-evaluator}

1. [コンセプト](./concepts.md)
2. [クイックスタート](./quickstart.md)
3. [Takosumi v1](../reference/takosumi-v1.md)
4. [Installer API](../reference/installer-api.md)
5. [仕様境界](../reference/spec-boundaries.md)

## Source を install する人 {#source-installers}

- 操作コマンドが必要になったら [CLI](../reference/cli.md)
- automation / integration が必要になったら [Installer API](../reference/installer-api.md)
- build service / CI から source archive を渡すなら [Build service 境界](../reference/build-spec.md)
- operator が提供する DB / OIDC / bucket などを選ぶなら [プラットフォームサービス](../reference/platform-services.md)

## Operator として動かす人 {#operators}

1. [コンセプト](./concepts.md)
2. [オペレーター](../operator/index.md)
3. [仕様境界](../reference/spec-boundaries.md)
4. [Installer API](../reference/installer-api.md)
5. [プラットフォームサービス](../reference/platform-services.md)
6. [ビルドサービス境界](../reference/build-spec.md)

## Takosumi とアカウント管理を読む人 {#cloud-operators}

1. [Takosumi](../reference/accounts.md)
2. [Takosumi docs](https://accounts.takosumi.com/docs/)
3. [Takosumi Distribution Contract v1](https://accounts.takosumi.com/docs/ja/spec)
4. [Operator Account-Plane Profile](https://accounts.takosumi.com/docs/ja/operator-account-plane-profile)
5. [Takosumi Accounts workload platform services](https://accounts.takosumi.com/docs/ja/workload-platform-services)
6. [Deploy Facade](https://accounts.takosumi.com/docs/ja/deploy-facade)

## Extension / runtime handler を作る人 {#provider-extension-authors}

1. [Takosumi を拡張する](../extending.md)
2. [仕様境界](../reference/spec-boundaries.md)
3. [プラットフォームサービス](../reference/platform-services.md)
4. implementation notes in the operator distribution

## Takosumi v1 に関わる人 {#takosumi-v1-contributors}

1. [仕様境界](../reference/spec-boundaries.md)
2. [Takosumi v1](../reference/takosumi-v1.md)
3. [Installer API](../reference/installer-api.md)
4. [プラットフォームサービス](../reference/platform-services.md)
5. 実装資料が必要になったら repository-local の内部設計メモを読む
