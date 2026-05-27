# バージョン整合 {#version-alignment}

::: info
本番環境のアップグレードコマンドはリリース固有の operator runbook に記載する。このページではパッケージ整合ルールを記録する。
:::

Takosumi の各パッケージは独立してバージョン管理される。公開適合面は manifest / Installation / Deployment と Installer API である。kind パッケージは operator がサポートする kind だけを有効にできるよう、個別にインストール可能になっている。

## パブリッシュ順序

1. `@takos/takosumi-contract`
2. `@takos/takosumi-installer`
3. `@takos/takosumi-runtime-agent`
4. `takosumi-plugins/` の `@takos/takosumi-runtime-agent-connectors`
5. `takosumi/` の portable `@takos/takosumi-kind-*` パッケージ
6. `@takos/takosumi-kernel`
7. `@takos/takosumi-cli`
8. `@takos/takosumi` umbrella
9. `takosumi-plugins/` の native `@takos/takosumi-kind-*` パッケージ

すべてのパッケージは pre-1.0 である。リリースノートで明示されない限り、minor bump に破壊的変更が含まれる可能性がある。

## Kind パッケージの整合

operator distribution は、有効にしている kind パッケージ・kernel・runtime-agent を同一のテスト済みリリースバンドルに揃えるべきである。有効にする kind を減らせば pin するパッケージも減らせる。

core/portable パッケージ一覧は `takosumi/scripts/jsr-publish-dry-run.ts` から生成される。`deno task publish:dry-run` は
local package metadata と publishability を確認し、`deno task publish:jsr` は `JSR_TOKEN` を使って未公開 target version
だけを publish する。すでに registry に見える target version は skip され、実 publish では `deno publish` の clean tree
check を残す。`deno task publish:check-jsr-records` は publish 後に public JSR registry の package record / target
version visibility を確認する。native パッケージのチェックは `takosumi-plugins/` にある。

## アップグレード確認項目

| 確認項目             | ソース                                                        |
| -------------------- | ------------------------------------------------------------- |
| パッケージバージョン | `scripts/jsr-publish-dry-run.ts` と各パッケージの `deno.json` |
| JSR 公開状態         | `deno task publish:check-jsr-records`                         |
| public API スモーク  | `takosumi install dry-run --source . --remote ...`            |
| スキーマ台帳         | リリース固有の operator evidence                              |
| 有効 kind スモーク   | operator 固有のライブプロビジョニング evidence                |

## 関連ページ

- [Operator Bootstrap](./bootstrap.md)
- [Kind Packages](../reference/kind-packages.md)
- [Operator-managed 運用](./operator-managed.md)
