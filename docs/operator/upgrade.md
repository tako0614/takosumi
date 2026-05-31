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

Takosumi は npm に公開する(JSR は使わない)。エコシステムの公開パッケージは 2 つだけ:
`@takosjp/takosumi`(core / kernel / installer / cli / runtime-agent。`takosumi` CLI bin を含む)と
`@takosjp/takosumi-plugins`(backend 実装。`@takosjp/takosumi` を peer dependency に持つ)。それぞれ独立した
version stream を持つ。

source は Deno-first で、dnt(Deno→Node Transform)で npm 形へ変換して publish する:

```bash
# 1) takosumi を先に publish(plugins の peer になるため順序が必須)
cd takosumi && deno run -A scripts/build-npm.ts && cd npm && npm publish --access public
# 2) takosumi が npm に乗ったら plugins を build(peer を解決)して publish
cd takosumi-plugins && deno run -A scripts/dnt-build.ts && cd npm && npm publish --access public
```

`npm publish --dry-run` で公開内容(version / files / peerDependencies)を事前確認できる。version は
`@takosjp/takosumi` が `takosumi/deno.json` の `version`、`@takosjp/takosumi-plugins` が
`takosumi-plugins/scripts/dnt-build.ts` の package version で管理する。

`deno task publish:check-jsr-records` は publish 後に public JSR registry の package record / target version visibility
を確認する。native パッケージのチェックは `takosumi-plugins/` にある。

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
