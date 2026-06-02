# バージョン整合 {#version-alignment}

::: info
本番環境のアップグレードコマンドはリリース固有の operator runbook に記載する。このページではパッケージ整合ルールを記録する。
:::

Takosumi の公開パッケージは product ごとに独立してバージョン管理される。公開適合面は Source / Installation / Deployment / PlatformService / InstallPlan と Installer API である。operator が有効にする backend-specific implementation は `@takosjp/takosumi-plugins/kind/<alias>` subpath で選ぶ。

## パブリッシュ順序

1. `takosumi/` の `@takosjp/takosumi`
2. `takosumi-plugins/` の `@takosjp/takosumi-plugins`

すべての公開パッケージは product ごとの独立 version stream を持つ。リリースノートで明示されない限り、pre-1.0 の minor bump に破壊的変更が含まれる可能性がある。

## Kind implementation の整合

operator distribution は、有効にしている `@takosjp/takosumi-plugins` subpath implementation・service・runtime-agent を同一のテスト済みリリースバンドルに揃えるべきである。有効にする backend implementation を減らせば検証対象も減らせるが、npm package は `@takosjp/takosumi-plugins` 1 つである。

Takosumi は npm に公開する(JSR は使わない)。エコシステムの公開パッケージは 2 つだけ:
`@takosjp/takosumi`(Takosumi / service / installer / cli / runtime-agent。`takosumi` CLI bin を含む)と
`@takosjp/takosumi-plugins`(backend 実装。`@takosjp/takosumi` を peer dependency に持つ)。それぞれ独立した
version stream を持つ。

source は Bun-first で、npm publish 用の `npm/` 出力を build して publish する。`build:npm` は Bun script で npm package layout を生成する:

```bash
# dry-run rehearsal
cd takosumi && bun install --frozen-lockfile && bun run build:npm
cd npm && npm publish --dry-run --access public
cd ../../takosumi-plugins && bun install --frozen-lockfile && bun run build:npm
cd npm && npm publish --dry-run --access public

# 1) takosumi を先に publish(plugins の peer になるため順序が必須)
cd takosumi && bun install --frozen-lockfile && bun run build:npm && cd npm && npm publish --access public
# 2) takosumi が npm に乗ったら plugins を build(peer を解決)して publish
cd takosumi-plugins && bun install --frozen-lockfile && bun run build:npm && cd npm && npm publish --access public
```

`npm publish --dry-run --access public` で公開内容(version / files / peerDependencies)を事前確認できる。version は
`@takosjp/takosumi` が `takosumi/package.json`、`@takosjp/takosumi-plugins` が
`takosumi-plugins/package.json` で管理する。

## アップグレード確認項目

| 確認項目             | ソース                                                        |
| -------------------- | ------------------------------------------------------------- |
| パッケージバージョン | `package.json`                                                |
| npm 公開状態         | npm registry と `npm publish --dry-run`                       |
| public API スモーク  | `takosumi install dry-run --source . --remote ...`            |
| OpenTofu inventory 証跡 | `bun run opentofu:binding-snapshot-proof`                   |
| スキーマ台帳         | リリース固有の operator evidence                              |
| 有効 adapter スモーク | operator 固有のライブプロビジョニング evidence                |

## 関連ページ

- [Operator Bootstrap](./bootstrap.md)
- [Backend adapters](../reference/kind-packages.md)
- [Operator-managed 運用](./operator-managed.md)
