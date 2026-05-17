# Manifest Validation

> このページでわかること: manifest 5 phase validation の順序 / `DomainErrorCode`
> / error envelope。

Manifest 語彙そのものは `docs/manifest.md`。 本ページは validation phase の
順序、 phase ごとの `DomainErrorCode`、 envelope shape、 closed-vocabulary
rejection rule、 `${ref:...}` resolution、 Catalog / Space binding を集約しま
す。

Validation は side-effect free で、 plan / apply / destroy 前段に同一論理を
走らせ、 同じ入力に同じ結果を返します。 WAL への書込も apply pipeline 起動も
伴いません。

manifest envelope は `apiVersion: "1.0"` + `kind: Manifest` 固定の closed
envelope。 top-level は
`@context / apiVersion / kind / namespace / metadata / resources` で、 未知
top-level field を含めば schema phase で reject。 `@context` は optional な
JSON-LD context で、 推奨値は
`https://takosumi.com/contexts/manifest-v1.jsonld`。

## Validation phase 順序

5 phase fail-fast。 前 phase で reject なら後段は走りません。

| 順 | Phase                | 入力                                | 失敗時の `DomainErrorCode`                  |
| -- | -------------------- | ----------------------------------- | ------------------------------------------- |
| 1  | Syntax               | manifest bytes (YAML / JSON)        | `invalid_argument`                          |
| 2  | Schema               | parsed value                        | `invalid_argument`                          |
| 3  | Reference resolution | parsed value + resource scope       | `invalid_argument`                          |
| 4  | Catalog binding      | parsed value + bound CatalogRelease | `not_found` / `failed_precondition`         |
| 5  | Space context        | parsed value + auth-resolved Space  | `permission_denied` / `failed_precondition` |

各 step 合否は `details.validationStep` に記録され、 operator が失敗位置を一
意に識別できます。

## Step 1 — Syntax

YAML / JSON parser layer。

- 文法不正 / unterminated string / invalid escape / duplicate map key は
  `invalid_argument` で reject
- `Content-Type` を見ず入力 bytes を YAML として parse (`{}`-始まりは JSON
  superset として受理)
- BOM / trailing garbage / 0 byte は reject

`details.validationPath` は `$` (root) 固定、 `details.cause` に parser 位置
(`line` / `column`)。

## Step 2 — Schema (closed vocabulary)

closed vocabulary。 列挙以外の top-level / nested key を含む manifest は
reject (warning 降格なし)。

Top-level:

```text
@context | apiVersion | kind | namespace | metadata | resources
```

`@context` 値は non-empty string、 JSON-LD context object、 またはそれらの
non-empty array。 空 array / null / number は reject。

`metadata` の closed key:

```text
name | labels
```

template 展開する tool があれば、 kernel request 前に expand した
`resources[]` だけを送ります。

`resources[]` entry の closed key:

```text
shape | name | provider | spec | requires | metadata
```

Shape `spec` 内の closed vocabulary は当該 Shape の `validateSpec` で別途判
定 (Shape Catalog reference)。 `spec` 内では `artifact` / `source` / `port` /
`routes` 等 Shape 固有 field が許可されますが、 manifest envelope 共通 top-level
にはなりません。

reject される:

```text
target | with | source | artifact | uses | use
access | expose | from | host | path | protocol | port | methods
```

Schema phase が reject する条件:

| 条件                        | 例                    | 動作                      |
| --------------------------- | --------------------- | ------------------------- |
| 未知 field                  | `metadata.foo: bar`   | reject (warning にしない) |
| 必須 field 欠落             | `apiVersion` なし     | reject                    |
| 型違反                      | `metadata.name: 42`   | reject                    |
| closed enum 範囲外          | `access: super-admin` | reject                    |
| 値域外 (port 0, methods=[]) | `port: 0`             | reject                    |

`apiVersion` は `"1.0"` 固定、 `kind` は `"Manifest"` 固定。 両方とも値違反
は reject。

`details.validationPath` は `$.resources[2].spec.bindings.DB_PASSWORD` 形式の
JSONPath。

## Step 3 — Reference resolution

`${ref:<name>.<field>}` / `${secret-ref:<name>.<field>}` の解決層。

Grammar:

```text
ref-expr        := "${" ref-kind ":" ref-target "}"
ref-kind        := "ref" | "secret-ref"
ref-target      := identifier "." identifier
identifier      := [A-Za-z_][A-Za-z0-9_-]*
```

Reject 条件:

| 条件                                                     | code               |
| -------------------------------------------------------- | ------------------ |
| 文法不正 (`${ref:foo}` のように `.` がない)              | `invalid_argument` |
| `<name>` が manifest 内のどの resource にも一致しない    | `invalid_argument` |
| `<field>` が当該 resource の Shape `outputFields` にない | `invalid_argument` |
| `secret-ref:` を non-secret field に使う / その逆        | `invalid_argument` |
| Cycle detected (`a → b → a`)                             | `invalid_argument` |

Cycle detection は resource を node、 `${ref:...}` を edge とする graph に
DFS。 発見 cycle は `details.cycle: ["a", "b", "a"]` に全 node を載せます。

Resolution は purely structural で external lookup を伴いません。 output field
実値は plan / apply step で初めて埋まり、 本 step は「埋まる予定があること」
だけを検証します。

## Step 4 — Catalog binding

Manifest が参照する Shape / Provider は CatalogRelease に bind されている必要
があります。

Reject 条件:

| 条件                                                     | code                  |
| -------------------------------------------------------- | --------------------- |
| `shape: <id>` が現行 CatalogRelease に存在しない         | `not_found`           |
| `provider: <id>` が CatalogRelease に存在しない          | `not_found`           |
| Shape と provider の `implements` 不一致                 | `failed_precondition` |
| `requires[]` capability を provider が満たさない         | `failed_precondition` |
| Shape spec が当該 Shape の `validateSpec` を pass しない | `invalid_argument`    |

CatalogRelease 署名検証は
[Catalog Release Trust](/reference/catalog-release-trust) が manifest validation
前段で担当します。 本 step は署名済 CatalogRelease を入力として扱います。
registry primitive は adopted release descriptor を re-verify し、 key 未 enroll
/ revoked / publisher mismatch / signature failure を
`implementation-unverified` risk metadata で fail-closed に返します。

## Step 5 — Space context

auth credential から resolve された Space に manifest が admissible か判定。

public deploy route は単一 deploy bearer scope を Space context として使用
(`TAKOSUMI_DEPLOY_SPACE_ID`、 既定 `takosumi-deploy`)。 actor 単位の Space
membership / entitlement check は internal control-plane 側で enforce され、
public manifest body には現れません。

Reject 条件:

| 条件                                                          | code                  |
| ------------------------------------------------------------- | --------------------- |
| Manifest が target とする Shape を Space が許可していない     | `permission_denied`   |
| `metadata.name` が Space の deployment name policy に違反     | `permission_denied`   |
| Quota 超過 (resource count / artifact size / activation slot) | `resource_exhausted`  |
| Cross-Space `${ref:...}` が share lifecycle non-active        | `failed_precondition` |

`details.spaceId` を必ず載せる。Quota 超過時は `details.quotaDimension`
と現在値を載せる ([Quota / Rate Limit](/reference/quota-rate-limit))。

## Validation error envelope

Validation error はすべて kernel 共通の domain error envelope に従う。

```json
{
  "code": "invalid_argument",
  "message": "metadata.foo is not a known field",
  "requestId": "req:01J...",
  "details": {
    "validationPhase": "schema",
    "validationPath": "$.metadata.foo",
    "spaceId": "space:default",
    "manifestDigest": "sha256:..."
  }
}
```

| Field                     | 必須           | 内容                                                    |
| ------------------------- | -------------- | ------------------------------------------------------- |
| `code`                    | yes            | `DomainErrorCode` 9 値の 1 つ                           |
| `message`                 | yes            | 人間可読の単一文                                        |
| `requestId`               | yes            | 1 リクエストにつき 1 つ                                 |
| `details.validationPhase` | yes            | `syntax` / `schema` / `reference` / `catalog` / `space` |
| `details.validationPath`  | yes            | JSONPath (root は `$`)                                  |
| `details.spaceId`         | phase 5 で必須 | Space id                                                |
| `details.cycle`           | cycle 検出時   | reference の node list                                  |
| `details.cause`           | optional       | parser / sub-error の構造化情報                         |

複数 reject 候補が同時成立しても、 validation は最初に firing した phase の
最初の error のみを返します (deterministic 保持のため)。 client は fix→retry
loop で残りを発見します。

## Closed vocabulary 違反の扱い

Schema phase の core invariant は「未知 field は warning ではなく reject」。
新 field 導入は `apiVersion` bump で別 schema を発行します。

これで operator が誤って future manifest を current kernel に投げた場合の
silent ignore を防ぎます。

## Schema versioning

`apiVersion` は manifest envelope 全体の wire schema 番号。

| 値      | 意味                                     |
| ------- | ---------------------------------------- |
| `"1.0"` | Takosumi v1 で kernel が受理する唯一の値 |

breaking change は `"2.0"` 等で発行し kernel が version ごとに routing。
`"1.0"` 以外を v1 kernel に投げれば reject。

## Idempotence

同一 manifest bytes に対する validation は phase / path / message が完全一致
します。 CI 上 dry-run と production kernel の plan 入力検証の等価性を担保し
ます。

## Related architecture notes

- `docs/reference/architecture/manifest-model.md`
- `docs/reference/architecture/policy-risk-approval-error-model.md`
- `docs/reference/architecture/catalog-release-descriptor-model.md`
- `docs/reference/architecture/space-model.md`
- `docs/reference/architecture/target-model.md`

## 関連ページ

- [Kernel HTTP API](/reference/kernel-http-api)
- [Closed Enums](/reference/closed-enums)
- [Risk Taxonomy](/reference/risk-taxonomy)
- [Catalog Release Trust](/reference/catalog-release-trust)
- [Shape Catalog](/reference/shapes)
- [Quota and Rate Limit](/reference/quota-rate-limit)
