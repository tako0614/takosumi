# Manifest Expand Semantics

> このページでわかること: manifest の expand (参照解決) セマンティクス。

本ページは manifest 内 `${ref:...}` 解決の v1 contract である: 文法、解決
タイミング、解決順序、循環検出、未解決 ref 規則、コンポーネント間スコープ
規則、Space 間参照の現状の拒否、template との相互作用、リテラル値と参照値の
区別、エスケープ規則、bind 時の型強制規則を定める。

## Grammar

A reference is a single token of the form

```text
${ref:<resource>.<field>[.<subfield>...]}
```

- `<resource>` names a component declared in the same manifest. The `share:`
- `<field>` is a top-level output field on the resource.
- `<subfield>` is a dot-path into a nested object output. Array indexing is
  **not** supported in v1; outputs that need element access expose a flat field
  instead.

References may be embedded inside string values:

```yaml
url: "${ref:web.endpoint}/api"
dsn: "postgres://${ref:db.user}:${ref:db.password}@${ref:db.host}/app"
```

A reference is **not** allowed in field names, key positions, or non-string
scalars at the source layer. Coercion to non-string types happens at bind time
(see [Type coercion](#type-coercion)).

## Resolution timing

Resolution runs in two distinct phases.

1. **Validation phase** — during manifest parse, the kernel walks every value,
   parses each `${ref:...}` token, validates the grammar, and builds the
   dependency DAG. Syntax errors surface as `invalid_argument` immediately,
   before any resource is touched.
2. **Resolution phase** — during `resolve`, the kernel walks the DAG in
   topological order and binds each reference to the actual output value of the
   producing resource.

bind された値は `ResolutionSnapshot` に capture され、OperationPlan の生存期間
中は immutable となる。同じ manifest の再 `apply` は両 phase を再実行し、新しい
snapshot を生成する。

## Resolution order

Resolution follows the dependency DAG.

- The kernel computes the DAG from the validation phase: an edge runs from `A`
  to `B` when `B` carries `${ref:A.<field>}`.
- Resolution proceeds from leaves (resources with no outgoing edges) toward
  roots. A resource is resolvable only after every resource it depends on has
  been resolved.
- Nested references are resolved bottom-up: `${ref:web.endpoint}/api` resolves
  `web.endpoint` first, then concatenates the suffix.

並列度は実装定義である。kernel は独立 leaf を並行 resolve しうる。真実の source
は DAG であって解決値の wall-clock 到着順ではないため、snapshot は resolve
順序によらず決定的である。

## Cycle detection

Cycles in the DAG are rejected at validation time.

- The kernel runs a depth-first search over the DAG. The first back-edge
  encountered surfaces a cycle.
- The error code is `invalid_argument` (closed `DomainErrorCode` enum). The
  error payload includes the cycle path: `a -> b -> c -> a`.
- A self-reference (`a -> a`, where component `a` references its own output) is
  a cycle of length one and is rejected with the same error code.

kernel は partial-cycle 解決を実装しない。循環を含む manifest は operator が
それを取り除くまで処理不能である。

## Unresolved references

Three failure modes exist for an otherwise-well-formed reference.

- **Missing resource.** `${ref:cache.url}` where `cache` is not declared in the
  manifest → `invalid_argument` at validation phase.
- **Missing field.** `${ref:db.totallyUnknown}` where `db` is declared but does
  not expose `totallyUnknown` → `invalid_argument` at validation phase. Field
  availability is derived from the resource's shape contract.
- **Unproduced output.** `${ref:db.connectionString}` where `db` exists but has
  not yet been applied (its `connectionString` output is therefore unbound) →
  resolution **fails**, the kernel pauses the OperationPlan, applies `db` first,
  and re-runs resolution for the dependent resource. The outer apply is
  replayed, not rejected; the apply pipeline drives the producing resource
  through its WAL stages before re-attempting the consumer.

最初の 2 つは静的 manifest エラーで、operator に同期的に surface する。3 つ目 は
kernel が operator に代わって解決する動的依存である。

## Cross-component references

References cross **only** component boundaries. A component never references its
own outputs.

- `${ref:self.field}` is forbidden. A field that needs a value derived from the
  same component computes the value at the source layer (template, shape
  provider, or hand-authored manifest), not through a reference.
- The kernel rejects intra-component references at validation phase with
  `invalid_argument` and a `self-reference` discriminator.

## Cross-Space references

Cross-Space references are rejected in current v1. Two Spaces are not connected

- The share-aware reference syntax is

  ```text
  ${ref:share:<shareId>.<field>}
  ```

  Here `<shareId>` is the share alias declared in the importing Space's manifest
  header.
- A share reference resolves against the share's exported field set, not the
  producing component's full output. Fields that the share does not export are
  not visible.
- A share whose lifecycle state is `revoked` or `stale` resolves to a hard
  failure: the kernel halts the consuming OperationPlan and surfaces a
  share-state error that names the share.

A bare `${ref:<resource>.<field>}` against a resource in another Space is
rejected with `invalid_argument`.

## Interaction with templates

Templates expand into a set of resources that participate in the same DAG as
hand-authored resources.

- A template's inputs may themselves carry `${ref:...}` tokens. The template's
  expansion happens **before** resolution; the resulting resources expose their
  references in the same DAG.
- A reference into a template-produced resource uses the same
  `${ref:<name>.<field>}` syntax. The template's output names form the
  consumable namespace.
- Templates do not introduce a new reference grammar. Anything that works for
  hand-authored resources works for template-expanded resources.

## Static literals vs references

A value is a reference only when its parse contains a `${ref:...}` token.
Everything else is a literal.

```yaml
image: "nginx:1.25" # literal
image: "${ref:registry.imageRef}" # reference
image: "registry.example.com/${ref:app.name}:1.0" # mixed
```

A literal value is recorded into the snapshot as-is. A reference is resolved,
then the resolved string is recorded.

## Escape

A literal `$` is expressed as `$$`.

```yaml
shellCommand: "echo $$HOME" # emits literal "$HOME"
template: "$${ref:not.parsed}" # emits literal "${ref:not.parsed}"
```

kernel は validation 中に `$$` を 1 度処理する。ネスト した escape (`$$$$`) は
ペア単位で畳まれる。

## Type coercion

A reference may resolve into a value whose declared output type does not match
the bind site's declared input type. The kernel coerces under a closed rule set.

| Output type | Bind type | Behaviour                                                               |
| ----------- | --------- | ----------------------------------------------------------------------- |
| string      | string    | identity                                                                |
| number      | string    | converted via canonical decimal form                                    |
| boolean     | string    | converted to `true` / `false`                                           |
| string      | number    | parsed as decimal; failure → `invalid_argument`                         |
| string      | boolean   | accepts `true` / `false` only; failure → `invalid_argument`             |
| object      | string    | rejected; rebind through a string-typed field on the producing resource |
| any         | object    | rejected unless the producing field is itself an object                 |

A coercion failure is a static error in the resolution phase and surfaces with
the bind site path in the error payload.

## Related architecture notes

- `reference/architecture/snapshot-model` — derivation of the ResolutionSnapshot
  from the resolved DAG.
- `reference/architecture/operation-plan-write-ahead-journal-model` — replay
  semantics when an `unproduced output` resolution drives the consumer through a
  re-resolve.
- `reference/architecture/policy-risk-approval-error-model` — placement of the
  `invalid_argument` code in the closed DomainErrorCode enum.

## 関連ページ

- [Manifest Validation](/reference/manifest-validation)
- [Templates](/reference/templates)
- [Shapes](/reference/shapes)
- [Closed Enums](/reference/closed-enums)
