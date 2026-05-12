# Manifest Validation

> Stability: stable Audience: kernel-implementer See also:
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Catalog Release Trust](/reference/catalog-release-trust),
> [Shape Catalog](/reference/shapes),
> [Quota and Rate Limit](/reference/quota-rate-limit)

Takosumi v1 における manifest validation の正式仕様。Manifest 語彙そのものは
`docs/manifest.md` で列挙する。本 reference は **validation phase** の順序、 各
phase で検出される失敗の `DomainErrorCode`、validation error envelope の
shape、closed-vocabulary rejection rule、`${ref:...}` resolution rule、 Catalog
binding と Space context の binding rule を集約する。

Validation は **side-effect free**。WAL への書き込みも apply pipeline の
起動も伴わない。Validation は plan / apply / destroy いずれの前段でも
同一の論理を走らせ、同じ入力に対して同じ結果を返す。

Takosumi v1 の manifest envelope は `apiVersion: "1.0"` + `kind: Manifest`
固定の closed envelope を採用する。これは Takosumi 実装が受理する正式な v1
形式であり、本 reference 群 (`docs/manifest.md` および本ページ) が canonical
source となる。envelope の closed top-level shape は
`@context / apiVersion / kind / namespace / metadata / resources` で、未知
top-level field を含む manifest は schema phase で reject される。 `@context` は
optional な JSON-LD context で、推奨値は
`https://takosumi.com/contexts/manifest-v1.jsonld`。

## Validation phase 順序

Manifest は次の 5 phase を **fail-fast** で順に通過する。前の phase で reject
された場合、後段は走らない。

| 順 | Phase                | 入力                                | 失敗時の `DomainErrorCode`                  |
| -- | -------------------- | ----------------------------------- | ------------------------------------------- |
| 1  | Syntax               | manifest bytes (YAML / JSON)        | `invalid_argument`                          |
| 2  | Schema               | parsed value                        | `invalid_argument`                          |
| 3  | Reference resolution | parsed value + resource scope       | `invalid_argument`                          |
| 4  | Catalog binding      | parsed value + bound CatalogRelease | `not_found` / `failed_precondition`         |
| 5  | Space context        | parsed value + auth-resolved Space  | `permission_denied` / `failed_precondition` |

各 step の合否は `details.validationStep` field に記録され、operator が
失敗位置を一意に識別できる。

## Step 1 — Syntax

YAML / JSON parser layer。

- 文法不正 / unterminated string / invalid escape / duplicate map key は
  `invalid_argument` で reject。
- `Content-Type` を見ず、入力 bytes を YAML として parse する。`{}`-始まり
  の入力は YAML が JSON superset として受理する。
- BOM / trailing garbage / 0 byte 入力は reject。

`details.validationPath` は `$` (root) に固定で、`details.cause` に parser 位置
(`line` / `column`) を載せる。

## Step 2 — Schema (closed vocabulary)

Manifest envelope は **closed vocabulary**。次に列挙する key 以外の top-level
および nested key を含む manifest は reject される。具体的には、 top-level に
`@context / apiVersion / kind / namespace / metadata / resources` 以外の field
が現れた時点で `invalid_argument` で reject される (warning に 降格しない)。

Top-level:

```text
@context | apiVersion | kind | namespace | metadata | resources
```

`@context` の値は non-empty string、JSON-LD context object、またはそれらの
non-empty array。空 array / null / number は schema phase で reject される。

`metadata` の closed key:

```text
name | labels
```

Template expansion, if used by a tool, must run before the kernel request and
submit only expanded `resources[]`.

`resources[]` entry の closed key:

```text
shape | name | provider | spec | requires | metadata
```

Shape `spec` 内の closed vocabulary は当該 Shape の `validateSpec` で別途
判定する (Shape Catalog reference)。`spec` 内では `artifact` / `source` / `port`
/ `routes` など Shape 固有 field が許可され得るが、manifest envelope 共通の
top-level field にはならない。

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

`apiVersion` は `"1.0"` 固定。`kind` は `"Manifest"` 固定。両方とも値違反は
schema phase で reject する。

`details.validationPath` には `$.resources[2].spec.bindings.DB_PASSWORD` 形式の
JSONPath を入れる。

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

Cycle detection は resource を node、`${ref:...}` を edge とする graph に 対する
DFS で行う。発見した cycle は `details.cycle: ["a", "b", "a"]` に 全 node
を載せる。

Resolution は **purely structural**。external lookup を伴わない。Output field
の実値は plan / apply step で初めて埋まる。Reference resolution step
は「埋まる予定があること」だけを検証する。

## Step 4 — Catalog binding

Manifest が参照する Shape / Provider は CatalogRelease に bind
されていなければならない。

Reject 条件:

| 条件                                                     | code                  |
| -------------------------------------------------------- | --------------------- |
| `shape: <id>` が現行 CatalogRelease に存在しない         | `not_found`           |
| `provider: <id>` が CatalogRelease に存在しない          | `not_found`           |
| Shape と provider の `implements` 不一致                 | `failed_precondition` |
| `requires[]` capability を provider が満たさない         | `failed_precondition` |
| Shape spec が当該 Shape の `validateSpec` を pass しない | `invalid_argument`    |

CatalogRelease の signature 検証は
[Catalog Release Trust](/reference/catalog-release-trust) が担当し、 manifest
validation の前段に置かれる。Manifest validation 自身は 署名済 CatalogRelease
を入力として扱う。Current registry primitive は adopted release の descriptor を
re-verify し、key 未 enroll / revoked / publisher mismatch / signature failure
を `implementation-unverified` risk metadata として fail-closed に 返す。

## Step 5 — Space context

Auth credential から resolve された Space に対して manifest が admissible
かを判定する。

Current public deploy route uses the single deploy bearer scope as that Space
context: `TAKOSUMI_DEPLOY_SPACE_ID`, defaulting to `takosumi-deploy`. Full
per-actor Space membership / entitlement checks are enforced by the internal
control-plane path and remain outside the public manifest body.

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

複数の reject 候補が同時に成立した場合でも、validation は **最初に firing した
phase の最初の error** のみを返す。クライアントは fix→retry の loop
で残りを発見する。これは validation を deterministic に保つため。

## Closed vocabulary 違反の扱い

Schema phase の core invariant は「未知 field は warning ではなく reject」。
Forward compatibility の理由で warning に降格することはしない。新しい field
を導入したい場合は `apiVersion` を bump して別 schema を発行する。

これにより、operator が誤って次世代 manifest を旧 kernel に投げた場合に silent
ignore されることがない。

## Schema versioning

`apiVersion` は manifest envelope 全体の wire schema 番号。

| 値      | 意味                                     |
| ------- | ---------------------------------------- |
| `"1.0"` | Takosumi v1 で kernel が受理する唯一の値 |

将来の breaking change は `"2.0"` 等で発行され、kernel が version ごとに routing
する。`"1.0"` 以外を v1 kernel に投げると schema phase で reject される。

## Idempotence

同一の manifest bytes に対する validation は phase / path / message が
完全一致する。これにより CI 上での dry-run と production kernel の plan
入力検証が等価であることを担保する。

## Related architecture notes

- `docs/reference/architecture/manifest-model.md`
- `docs/reference/architecture/policy-risk-approval-error-model.md`
- `docs/reference/architecture/catalog-release-descriptor-model.md`
- `docs/reference/architecture/space-model.md`
- `docs/reference/architecture/target-model.md`
