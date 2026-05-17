# AppSpec Validation

> このページでわかること: `.takosumi.yml` validation の phase 順序と error envelope。

`.takosumi.yml` (= AppSpec) は side-effect free に validate されます。 dry-run /
apply / rollback の前段に同一論理を走らせ、 同じ入力に同じ結果を返します。
WAL 書込も provider 呼出も伴いません。

仕様の正本: [AppSpec](./app-spec.md) /
[Component Kind Catalog](./component-kind-catalog.md) /
[Installer API](./installer-api.md)。

## Validation phase 順序

5 phase fail-fast。 前 phase で reject なら後段は走りません。

| 順 | Phase                | 入力                                | 失敗時の `code`                     |
| -- | -------------------- | ----------------------------------- | ----------------------------------- |
| 1  | Syntax               | `.takosumi.yml` bytes (YAML)        | `invalid_argument`                  |
| 2  | Schema               | parsed AppSpec                      | `invalid_argument`                  |
| 3  | Use edge resolution  | parsed AppSpec + components scope   | `invalid_argument`                  |
| 4  | Kind catalog binding | parsed AppSpec + provider registry  | `not_found` / `failed_precondition` |
| 5  | Space context        | parsed AppSpec + auth-resolved Space | `permission_denied` / `failed_precondition` |

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
kind | build | use | routes | spec | redirectPaths | scopes | name | target
```

Schema phase が reject する条件:

| 条件                                | 動作                       |
| ----------------------------------- | -------------------------- |
| 未知 field                          | reject (warning にしない) |
| 必須 field 欠落                     | reject                     |
| `kind` が catalog 5 種でない        | reject                     |
| 型違反                              | reject                     |
| closed enum 範囲外                  | reject                     |

## Step 3 — Use edge resolution

`use:` edge の static check。

| 条件                                                          | code               |
| ------------------------------------------------------------- | ------------------ |
| `use: <name>` が components の key にない                     | `invalid_argument` |
| `use: <name>` の `mount` が target kind の reserved mount に一致しない | `invalid_argument` |
| Cycle detected (`web → db → web`)                             | `invalid_argument` |
| `use: <name>` の `env` / `envPrefix` が無効な env var 名      | `invalid_argument` |

Cycle detection は component を node、 `use:` を edge とする graph に DFS。
発見 cycle は `details.cycle: ["web", "db", "web"]` に全 node。

## Step 4 — Kind catalog binding

各 component の `kind` が catalog 5 種のいずれかであり、 provider plugin が
解決可能であることを検証。

| 条件                                                             | code                  |
| ---------------------------------------------------------------- | --------------------- |
| `kind: <id>` が catalog (5 種) に存在しない                     | `not_found`           |
| 解決された provider が当該 kind の spec を validate に通せない  | `invalid_argument`    |
| 解決された provider が `use:` edge の target kind を提供できない | `failed_precondition` |

provider plugin は operator が catalog から bind します。 詳細:
[Architecture: Kernel](./architecture/kernel.md)。

## Step 5 — Space context

auth credential から resolve された Space に AppSpec が admissible か判定。

| 条件                                                          | code                  |
| ------------------------------------------------------------- | --------------------- |
| AppSpec が要求する `kind` を Space が許可していない           | `permission_denied`   |
| `metadata.id` が Space の name policy に違反                  | `permission_denied`   |
| Quota 超過 (component count / artifact size / activation slot) | `resource_exhausted`  |

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

| 値                   | 意味                            |
| -------------------- | ------------------------------- |
| `"takosumi.dev/v1"`  | v1 で kernel が受理する唯一の値 |

breaking change は `"takosumi.dev/v2"` 等で発行し kernel が version ごとに routing。

## Idempotence

同一 AppSpec bytes に対する validation は phase / path / message が完全一致
します。 CI 上 dry-run と production kernel の検証の等価性を担保します。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Component Kind Catalog](./component-kind-catalog.md)
- [Installer API](./installer-api.md)
- [Kernel HTTP API](./kernel-http-api.md)
