# 読む順序 {#reading-paths}

## 初めて読む人 {#first-time-evaluator}

1. [コンセプト](./concepts.md)
2. [クイックスタート](./quickstart.md)
3. [Manifest](../reference/manifest.md)
4. [Takosumi core 仕様](../reference/core-spec.md)
5. [仕様境界](../reference/spec-boundaries.md)
6. 公開 contract の範囲を確認したくなったら
   [リファレンス索引](../reference/index.md)

## Manifest を書く人 {#appspec-authors}

上記の「初めて読む人」の順に読んだ後、以下も参照:

- kind や出力の型 (`service-binding` 等) の具体語彙が必要になったら
  [対応 kind 一覧](../reference/type-catalog.md)
- operator が提供する外部サービスの出力データを workload から受け取るときは
  [外部サービス](../reference/external-publications.md)
- Takosumi Cloud が提供する workload 向け publish の出力、deploy
  facade、dashboard API などアカウント管理 (課金・認証) / admin surface
  が必要になったら [Takosumi Cloud](../reference/takosumi-cloud.md)
- public app endpoint を出すときは [HTTP 公開](../reference/http-exposure.md)
- build が必要になったら [Build service 境界](../reference/build-spec.md)
- 操作コマンドが必要になったら [CLI](../reference/cli.md)
- automation / integration が必要になったら
  [Installer API](../reference/installer-api.md)

## Operator として動かす人 {#operators}

1. [コンセプト](./concepts.md)
2. [オペレーター](../operator/index.md)
3. [Installer API](../reference/installer-api.md)
4. [ビルドサービス境界](../reference/build-spec.md)
5. [ビルドサービス例](../operator/build-service-profile.md)
6. [HTTP 公開](../reference/http-exposure.md)
7. 必要な仕様を引くときは [リファレンス索引](../reference/index.md)

## Takosumi Cloud とアカウント管理を読む人 {#cloud-operators}

1. [Takosumi Cloud](../reference/takosumi-cloud.md)
2. [Takosumi Cloud docs](https://cloud.takosumi.com/docs/)
3. [Takosumi Cloud Distribution Contract v1](https://cloud.takosumi.com/docs/ja/spec)
4. [Operator Account-Plane Profile](https://cloud.takosumi.com/docs/ja/operator-account-plane-profile)
5. [Workload External Publications](https://cloud.takosumi.com/docs/ja/workload-publications)
6. [Account-Plane Projections](https://cloud.takosumi.com/docs/ja/account-plane-projections)
7. [Deploy Facade](https://cloud.takosumi.com/docs/ja/deploy-facade)

## Provider や extension を作る人 {#provider-extension-authors}

1. [Takosumi を拡張する](../extending.md)
2. [仕様境界](../reference/spec-boundaries.md)
3. [対応 kind 一覧](../reference/type-catalog.md)
4. [Manifest](../reference/manifest.md)
5. [外部サービス](../reference/external-publications.md)
6. [アクセスモード](../reference/access-modes.md)

## Core に関わる人 {#core-contributors}

1. [仕様境界](../reference/spec-boundaries.md)
2. [Takosumi core 仕様](../reference/core-spec.md)
3. [Manifest](../reference/manifest.md)
4. [Installer API](../reference/installer-api.md)
5. [外部サービス](../reference/external-publications.md)
6. [対応 kind 一覧](../reference/type-catalog.md)
7. 実装資料が必要になったら repository-local の内部設計メモを読む
