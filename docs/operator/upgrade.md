# バージョン整合 {#version-alignment}

::: info
本番環境のアップグレードコマンドはリリース固有の operator runbook に記載する。このページではパッケージ整合ルールを記録する。
:::

Takosumi の公開パッケージは product ごとに独立してバージョン管理される。公開適合面は Source / Installation / Deployment / PlatformService / InstallPlan と Installer API である。operator が有効にする backend-specific implementation は operator distribution の OpenTofu / Helm / native controller wiring で選ぶ。

## パブリッシュ

Takosumi から publish する npm package は `@takosjp/takosumi` だけです。
operator distribution が持つ backend implementation、runtime handler、inventory importer は operator の release bundle / image / IaC repo で管理します。

すべての公開パッケージは product ごとの独立 version stream を持つ。リリースノートで明示されない限り、pre-1.0 の minor bump に破壊的変更が含まれる可能性がある。

## Operator implementation の整合

operator distribution は、有効にしている OpenTofu stack、service image、runtime-agent image、runtime handler wiring、PlatformService inventory importer を同一のテスト済みリリースバンドルに揃えるべきである。有効にする backend implementation を減らせば検証対象も減らせるが、Takosumi npm package とは別管理である。

Takosumi は npm に公開する(JSR は使わない)。エコシステムの current public npm package は `@takosjp/takosumi`(Takosumi / service / installer / cli / runtime-agent。`takosumi` CLI bin を含む)だけである。

source は Bun-first で、npm publish 用の `npm/` 出力を build して publish する。`build:npm` は Bun script で npm package layout を生成する:

```bash
# dry-run rehearsal
cd takosumi && bun install --frozen-lockfile && bun run build:npm
cd npm && npm publish --dry-run --access public

cd takosumi && bun install --frozen-lockfile && bun run build:npm && cd npm && npm publish --access public
```

`npm publish --dry-run --access public` で公開内容(version / files)を事前確認できる。version は `takosumi/package.json` で管理する。

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
- [Operator backend implementations](../reference/kind-packages.md)
- [Operator-managed 運用](./operator-managed.md)
