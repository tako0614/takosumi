# ビルドサービス境界 {#build-service-handoff}

build service、CI、operator automation は、Installer API を呼ぶ前に source を準備できます。Takosumi core は build を実行しません。core が受け取るのは `source.kind: "prepared"` として渡された source input です。

Takosumi core は source handoff contract と Deployment source identity を定義します。build service は build recipe、command 実行、cache metadata、provenance、 payload の作り方を定義します。

このページは Takosumi core と build service / CI の責務境界を説明します。 Installer API の wire field は [Installer API](./installer-api.md) を正本にします。

## Handoff の流れ

```text
source root
  -> build service / CI が source を準備する
  -> build service が prepared source payload を作る
  -> build service が payload digest を計算する
  -> caller が prepared source URL + digest を Installer API に渡す
  -> Installer が payload を検証し、.takosumi.yml を読む
  -> Installer が Deployment source identity を記録する
```

`source.digest` は Installer が取得した payload bytes の sha256 です。build graph digest、tree canonicality digest、package manager lock digest、cache key、 provenance digest ではありません。

## Core handoff ルール

prepared source は build service、CI、operator automation が作る source handoff payload です。 Takosumi core が見るのは build の中身ではなく、Installer API に渡された source input です。

core handoff rules:

- payload は `.takosumi.yml` を含む resolved source root を表す。
- manifest 内の runtime file path は resolved source root からの relative path。
- Installer API は payload digest、source path safety、size cap、manifest parse を resource side effect 前に検証する。
- Installer API が response / Deployment record に残す source identity は、build service の recipe や cache key ではなく Installer が検証した source input。

concrete wire fields、portable payload profile、error mapping は [Installer API](./installer-api.md) の一部です。Portable Installer API v1 の prepared source payload は POSIX tar です。uncompressed tar と gzip-compressed tar (`.tar.gz` / gzip magic bytes) を受け付け、digest は fetched payload bytes 全体に対して計算します。build recipe、cache metadata、provenance は build-service profile に残します。

## Prepared source archive contract {#prepared-source-archive-contract}

Portable Installer API v1 の prepared source archive は POSIX tar です。archive は `.takosumi.yml` を含む source root を表し、Installer は取得した payload bytes の sha256 を `source.digest` として検証します。gzip-compressed tar の場合も、digest は圧縮済み payload bytes を対象にします。path traversal、 absolute path、NUL byte、source root 外への escape、operator policy の size cap 違反は resource side effect 前に reject します。

component kind schema metadata が source path field として扱う値は、resolved source root 内に存在し、source root から escape せず、注入 policy に反しない必要があります。dry-run は side effect なしで決定できる schema / kind の定義 / source path のバリデーションを返し、apply はリソースの作成・更新前に selected binding で同じバリデーションを繰り返します。

## Manifest との関係

manifest は runtime / install intent を持ちます。runtime file path は `worker.spec.entrypoint` のような kind-specific `spec` field に置きます。build command、build node、container image、dependency cache、generated intermediate output、provenance record は manifest の外に置きます。

build-service distribution は `.takosumi.build.yml`、別の filename、hosted CI workflow、または recipe file なしの workflow を定義できます。Takosumi core はその結果として作られた prepared source input だけを Installer API 経由で受け取ります。

## 置き場所

| 内容                            | Surface                                        |
| ------------------------------- | ---------------------------------------------- |
| runtime / install intent        | manifest                                       |
| runtime file path               | kind-specific `spec`                           |
| build recipe / build graph      | build-service profile / CI                     |
| prepared source URL             | Installer API source input                     |
| resolved prepared source digest | dry-run / apply response and Deployment record |
| workflow / trigger / approval   | operator automation / account layer workflow   |

## 関連ページ

- [manifest](./manifest.md)
- [Installer API](./installer-api.md)
- [Operator build-service profile example](../operator/build-service-profile.md)
- [Takosumi 公式カタログ仕様](./catalog.md)
