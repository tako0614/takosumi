# リファレンス {#reference}

## Takosumi v1

- [仕様境界](./spec-boundaries.md) — Takosumi、operator distribution、integration package の責務分離。
- [Takosumi v1](./takosumi-v1.md) — Source / Installation / Deployment / PlatformService、Installer API、guard、ledger。
- [Installer API](./installer-api.md) — Installation / Deployment を作成・更新・rollback する public API。
- [プラットフォームサービス](./platform-services.md) — operator inventory から service binding を選択し、Deployment に記録する model。
- [ダイジェスト計算](./digest-computation.md) — source pin、prepared source digest、`planSnapshotDigest`。
- [CLI](./cli.md) — Installer API を呼ぶ `takosumi` command surface。
- [用語集](./glossary.md) — current v1 用語の短い定義。

## Operator / integration

- [Takosumi 入口](./accounts.md) — reference operator distribution docs への入口。
- [ビルドサービス境界](./build-spec.md) — build service / CI が prepared source archive payload を作る convention。
- [ビルドサービス例](../operator/build-service-profile.md) — Linux container を使う build service profile の非規定例。
- Runtime-agent details live in repository-local operator notes; public v1
  focuses on PlatformService bindings.
- [Takosumi を拡張する](../extending.md) — PlatformService inventory importer / runtime-agent handler / backend adapter の境界。

## Retired material

Historical v0 authoring pages are not v1 public contract. v1 source repos are manifestless.
