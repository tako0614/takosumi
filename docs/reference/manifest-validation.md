# AppSpec Validation

> このページでわかること: `.takosumi.yml` validation の phase 順序と error
> envelope。

`.takosumi.yml` (= AppSpec) は side-effect free に validate されます。 dry-run /
apply / rollback の前段に同一論理を走らせ、 同じ入力に同じ結果を返します。 WAL
書込も provider 呼出も伴いません。

仕様の正本: [AppSpec](./app-spec.md) /
[Component Kind Catalog](./component-kind-catalog.md) /
[Installer API](./installer-api.md)。

## Validation phase 順序

5 phase fail-fast。 前 phase で reject なら後段は走りません。

| 順 | Phase                       | 入力                                   | 失敗時の `code`                             |
| -- | --------------------------- | -------------------------------------- | ------------------------------------------- |
| 1  | Syntax                      | `.takosumi.yml` bytes (YAML)           | `invalid_argument`                          |
| 2  | Schema                      | parsed AppSpec                         | `invalid_argument`                          |
| 3  | Publish / Listen resolution | parsed AppSpec + components scope      | `invalid_argument`                          |
| 4  | Kind catalog binding        | parsed AppSpec + materializer registry | `not_found` / `failed_precondition`         |
| 5  | Space context               | parsed AppSpec + auth-resolved Space   | `permission_denied` / `failed_precondition` |

各 step 合否は `details.validationPhase` に記録。

## Step 1 — Syntax

YAML parser layer。

- 文法不正 / unterminated string / invalid escape / duplicate map key は
  `invalid_argument` で reject
- BOM / trailing garbage / 0 byte は reject

## Step 2 — Schema (closed vocabulary)

closed vocabulary。 列挙以外の top-level / nested key を含む AppSpec は reject
(warning 降格なし)。

Top-level closed key:

```text
apiVersion | kind | metadata | components | interfaces | permissions
```

`apiVersion` は `"takosumi.dev/v1"` 固定、 `kind` は `"App"` 固定。

各 component の closed key (kind ごとに validate):

```text
kind | build | spec | publish | listen | name
```

Schema phase が reject する条件:

| 条件                           | 動作                      |
| ------------------------------ | ------------------------- |
| 未知 field                     | reject (warning にしない) |
| 必須 field 欠落                | reject                    |
| `kind` の URI / alias が未解決 | reject                    |
| 型違反                         | reject                    |
| closed enum 範囲外             | reject                    |

## Step 3 — Publish / Listen resolution

`publish` / `listen` edge の static check。

| 条件                                                                                  | code               |
| ------------------------------------------------------------------------------------- | ------------------ |
| `listen: <path>` の対象 namespace path が同 AppSpec の publish にない                 | `invalid_argument` |
| `listen.<path>.mount` が target kind の reserved mount に一致しない                   | `invalid_argument` |
| Cycle detected (`web` が listen するパスを publish する component が `web` を listen) | `invalid_argument` |
| `listen.<path>.prefix` / `as: env` の env var prefix が無効                           | `invalid_argument` |

Cycle detection は component を node、 publish → listen を edge とする graph に
DFS。 発見 cycle は `details.cycle: ["web", "db", "web"]` に全 node。 operator
plane が publish する path (= `operator.identity.oidc` 等) は外部 edge として
扱い、 cycle 計算には含めない。

## Step 4 — Kind catalog binding

各 component の `kind` URI (= short alias を full URI に正規化したもの) に
対する materializer が registry に登録されていることを検証。

| 条件                                                                                | code                  |
| ----------------------------------------------------------------------------------- | --------------------- |
| `kind: <URI>` に対する materializer が registry に存在しない                        | `not_found`           |
| 解決された materializer が当該 kind の spec を validate に通せない                  | `invalid_argument`    |
| 解決された materializer が `listen` で要求された target kind の material を返さない | `failed_precondition` |

materializer は operator が `createPaaSApp({ plugins: [...] })` または
`createPaaSApp({ materializers: [...] })` で bind します。 詳細:
[Architecture: Kernel](./architecture/kernel.md)。

## Step 5 — Space context

auth credential から resolve された Space に AppSpec が admissible か判定。

| 条件                                                           | code                            |
| -------------------------------------------------------------- | ------------------------------- |
| AppSpec が要求する `kind` を Space が許可していない            | `permission_denied`             |
| `metadata.id` が Space の name policy に違反                   | `permission_denied`             |
| Quota 超過 (component count / artifact size / activation slot) | `resource_exhausted` (HTTP 413) |

`failed_precondition` は HTTP **409** に、 `resource_exhausted` は HTTP **413**
に mapping されます。

## Validation error envelope

```json
{
  "code": "invalid_argument",
  "message": "components.web.kind is not a known kind",
  "requestId": "req:01J...",
  "details": {
    "validationPhase": "schema",
    "validationPath": "$.components.web.kind",
    "spaceId": "space:default",
    "manifestDigest": "sha256:..."
  }
}
```

複数 reject 候補が同時成立しても、 validation は最初に firing した phase の
最初の error のみを返します (deterministic 保持のため)。 client は fix→retry
loop で残りを発見します。

## Schema versioning

`apiVersion` は AppSpec envelope 全体の wire schema 番号。

| 値                  | 意味                            |
| ------------------- | ------------------------------- |
| `"takosumi.dev/v1"` | v1 で kernel が受理する唯一の値 |

breaking change は `"takosumi.dev/v2"` 等で発行し kernel が version ごとに
routing。

## Idempotence

同一 AppSpec bytes に対する validation は phase / path / message が完全一致
します。 CI 上 dry-run と production kernel の検証の等価性を担保します。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Component Kind Catalog](./component-kind-catalog.md)
- [Installer API](./installer-api.md)
- [Kernel HTTP API](./kernel-http-api.md)
