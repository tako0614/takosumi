# Takosumi core 仕様 {#core-spec}

Takosumi core 仕様は、source を Space に install し、apply 結果を Deployment として記録するための portable contract です。公開 model は 3 つの entity に閉じます。

| Entity       | 意味                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| manifest     | source root の `.takosumi.yml`。component と connection を宣言する。                                 |
| Installation | Space に install された manifest の core record。current state を持つ。                              |
| Deployment   | Installation に対する 1 回の apply 結果。source identity、`manifestDigest`、status、outputs を持つ。 |

core 仕様が定義するもの:

- manifest の構造
- Installer API
- source input kind と digest guard
- publish/listen reference grammar

component kind、出力の形式、注入モードは解決可能な vocabulary string として扱います。その語彙は型カタログが定義します。

プラットフォームサービス path は operator または product distribution が公開するサービス一覧です。core は dotted grammar、exact-match resolution、Deployment の記録を定義します。

operator profile は、Space で見える型カタログ entry とプラットフォームサービスの有効なサービス一覧を選び、binding を接続し、billing、OIDC、dashboard、deploy facade などの account layer API を提供します。

## Installation から Deployment へのタイムライン

```text
1. source (git / prepared / local) を用意する
2. POST /v1/installations/dry-run → 変更計画 + expected guard を取得
3. POST /v1/installations         → Installation 作成 + 最初の Deployment
   ─── ここから Installation が存在する ───
4. source を更新する
5. POST /v1/installations/{id}/deployments/dry-run → 差分確認
6. POST /v1/installations/{id}/deployments         → 新しい Deployment
7. 問題があれば POST /v1/installations/{id}/rollback → 過去の Deployment に戻る
```

## Manifest

manifest root field:

```yaml
apiVersion: v1
metadata:
  id: com.example.app
  name: Example App
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

`components` は 1 つ以上の named component を持ちます。

Component field:

```yaml
components:
  web:
    kind: worker
    spec: {}
    publish: {}
    listen: {}
```

| Field     | Core meaning                                                     |
| --------- | ---------------------------------------------------------------- |
| `kind`    | operator profile が解決する文字列（Takosumi は値を解釈しない）。 |
| `spec`    | 選択された kind の定義に従う open object。                       |
| `publish` | component が外に出す出力名と出力の形式。                         |
| `listen`  | component が受け取る binding 名と参照先。                        |

上の short kind は、operator profile が Takosumi Kind カタログの alias を有効にしている場合の例です。compatible operator は alias ではなく URI を要求できます。

## Publish / listen

`publish` は component が作る出力データを宣言します。`listen` は別の publish の出力データを受け取ります。

```yaml
components:
  db:
    kind: postgres
    publish:
      connection:
        as: service-binding

  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: secret-env
```

この例は、kind name (`postgres`, `worker`) と出力の形式 / 注入モード名 (`service-binding`, `secret-env`) に operator profile の省略名と Kind カタログの省略名を使っています。`publish` と `listen` の構造は core が定義し、省略名の意味は Kind カタログが定義します。

`listen.<binding>.from` は 1 つの dotted reference grammar を使います。

| Shape                        | Resolution                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `component.publication`      | 同一 manifest 内の component の publish 出力。ちょうど 2 segment。 |
| `publisher.area.name[.more]` | Space で使えるプラットフォームサービス。3 から 8 segment。         |

component name、publish 名、listen binding name は `.` を含めないため、2 segment の local reference と 3 segment 以上のプラットフォームサービス path は parse 時点で区別できます。

プラットフォームサービスは component-local な publish の出力と同じ listen の仕組みに参加します。core 仕様は path grammar と resolution semantics を定義します。

publisher root と concrete path は operator または product distribution spec が定義します。選ばれた宣言の出力の形式は Takosumi Kind カタログ、または operator が採用した型カタログから選ばれます。

## Installer API

public Installer API は Installation を中心にした 5 endpoint です。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

この 5 endpoint が Takosumi core HTTP API です。dashboard、CLI、rollback target selection、support workflow のための read / list / history / poll surface は operator-owned read model です。追加の core Installer API endpoint ではありません。

Source input kind:

| Kind       | 意味                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `git`      | remote git source。apply guard は resolved commit + `manifestDigest`。                  |
| `prepared` | remote prepared source。apply guard は source digest + `manifestDigest`。               |
| `local`    | dev / operator-local 用の Takosumi-local source tree。apply guard は `manifestDigest`。 |

`manifestDigest` は raw `.takosumi.yml` bytes の sha256 です。prepared source では、Takosumi が取得した source payload の sha256 を計算します。

prepared source は core source kind です。Installer API が所有する要素:

- portable payload profile
- source root / path-safety rule
- size cap と payload digest guard

Portable v1 の prepared source payload は uncompressed POSIX tar です。 operator-local profile が別 archive encoding を受け付ける場合でも、portable v1 の互換条件ではありません。recipe、provenance、cache metadata は operator build-service profile が所有します。

`local` source は portable source byte identity を持たないため、deploy dry-run / apply では `source` を省略せずに渡します。build command、build graph node、cache key、provenance record は build service または operator automation の責務であり、core Installer API には入りません。

## Layer split

| Layer                  | Defines                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Takosumi core          | manifest の構造、publish/listen grammar、Installation / Deployment、Installer API、source / digest guard。 |
| Takosumi Kind カタログ | 再利用可能な kind の定義、出力の形式、注入モード名、JSON-LD catalog metadata。                             |
| Operator profile       | Space で利用できる kind の定義、出力の形式、プラットフォームサービス、account layer API、provider。        |

concrete workload 向けプラットフォームサービス path と account layer API / facade identifier は operator profile spec で定義します。Takosumi Cloud については [Takosumi Cloud](./takosumi-cloud.md) から読みます。

## 関連ページ

- [manifest](./manifest.md)
- [仕様境界](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./external-publications.md)
- [Takosumi Kind カタログ仕様](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
