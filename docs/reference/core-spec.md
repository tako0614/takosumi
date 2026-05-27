# Takosumi core 仕様 {#core-spec}

Takosumi core は source を Space に install し、apply 結果を Deployment
として記録する portable contract です。公開 model は 3 entity です。

| Entity       | 意味                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| manifest     | source root の `.takosumi.yml`。`metadata.id` と component graph を宣言し、必要に応じて Installation output service path declaration を記録する。 |
| Installation | Space に install された manifest の core record。current state を持つ。                                                                           |
| Deployment   | Installation に対する 1 回の apply 結果。source identity、`manifestDigest`、status、outputs を持つ。                                              |

core 仕様が定義するもの:

- AppSpec の形
- Installation / Deployment lifecycle
- Installer API
- source input kind と digest guard
- component output reference と platform service path grammar

component kind、output slot、material shape、注入モードの詳細は、operator
が採用した kind の定義と implementation binding が解決します。

## Manifest

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
publish:
  api:
    output: web.http
    path: acme.example.api
```

Component field:

```yaml
components:
  web:
    kind: worker
    spec: {}
    connect: {}
    listen: {}
```

| Field     | Core meaning                                             |
| --------- | -------------------------------------------------------- |
| `kind`    | operator distribution が解決する文字列。                 |
| `spec`    | 選択された kind の定義に従う open object。               |
| `connect` | 同じ manifest 内の component output を consumer に渡す。 |
| `listen`  | Space-visible platform service path を consumer に渡す。 |

Root `publish` は component output を Installation output service path declaration として記録します。operator / product distribution は、その宣言を Space-visible platform service inventory に投影できます。

## Connection Model

同じ manifest 内の確定的な接続:

```yaml
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
```

manifest 外の platform service:

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        required: true
```

Space-visible service path:

```yaml
publish:
  api:
    output: web.http
    path: acme.notes.api
```

| Shape                          | Resolution                                                |
| ------------------------------ | --------------------------------------------------------- |
| `component.output`             | 同一 manifest 内の component output。ちょうど 2 segment。 |
| `identity.primary.oidc[.more]` | Space で使える platform service。3 から 8 segment。       |

`connect` は `component.output` を参照します。`listen.path` は platform service
path を参照します。root `publish.path` は Deployment output に Installation output
declaration として記録されます。外部 consumer が解決できるかどうかは operator / product distribution がその declaration
を Space-visible platform service inventory に投影するかで決まります。
その inventory では、同じ Space の同じ path に active provider は 1 つだけです。別 owner の同一 path は自動上書きせず
conflict として扱います。

## Installer API

public Installer API は Installation を中心にした 5 endpoint です。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

dashboard、CLI、rollback target selection、support workflow のための read / list
/ history / poll surface は operator-owned read model です。

## Source Input

| Kind       | 意味                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `git`      | remote git source。apply guard は resolved commit + `manifestDigest`。                  |
| `prepared` | remote prepared source。apply guard は source digest + `manifestDigest`。               |
| `local`    | dev / operator-local 用の Takosumi-local source tree。apply guard は `manifestDigest`。 |

`manifestDigest` は raw `.takosumi.yml` bytes の sha256 です。prepared source
では、Takosumi が取得した source payload の sha256 を計算します。

Portable v1 の prepared source payload は uncompressed POSIX tar
です。recipe、provenance、cache metadata は operator build-service profile
が所有します。

## Layer Split

| Layer                   | Defines                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Takosumi core           | AppSpec shape、Installation / Deployment、Installer API、source / digest guard、reference grammar。              |
| Takosumi 公式型カタログ | 再利用可能な kind の定義、output slot、material vocabulary、JSON-LD catalog metadata。                           |
| Operator distribution   | Space で利用できる kind、platform service path、account layer API、provider binding、dashboard / deploy facade。 |

concrete workload 向け platform service path と account layer API / facade
identifier は operator distribution spec で定義します。Takosumi Cloud については
[Takosumi Cloud](./takosumi-cloud.md) を参照してください。

## 関連ページ

- [manifest](./manifest.md)
- [仕様境界](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
- [Takosumi 公式型カタログ仕様](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
