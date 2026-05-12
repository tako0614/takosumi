# Manifest Expand Semantics

> Stability: stable Audience: integrator, kernel-implementer See also:
> [Manifest Validation](/reference/manifest-validation),
> [Templates](/reference/templates), [Shapes](/reference/shapes),
> [Closed Enums](/reference/closed-enums)

This page is the v1 contract for `${ref:...}` resolution inside manifests: the
grammar, the resolution timing, the resolution order, cycle detection, the
unresolved-ref rules, the cross-component scoping rules, the current denial of
cross-Space references, the interaction with templates, the distinction between
literal and reference values, the escape rule, and the type coercion rules at
the bind point.

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

The bound values are captured into a `ResolutionSnapshot` and become immutable
for the lifetime of the OperationPlan. Re-`apply` of the same manifest re-runs
both phases and produces a fresh snapshot.

## Resolution order

Resolution follows the dependency DAG.

- The kernel computes the DAG from the validation phase: an edge runs from `A`
  to `B` when `B` carries `${ref:A.<field>}`.
- Resolution proceeds from leaves (resources with no outgoing edges) toward
  roots. A resource is resolvable only after every resource it depends on has
  been resolved.
- Nested references are resolved bottom-up: `${ref:web.endpoint}/api` resolves
  `web.endpoint` first, then concatenates the suffix.

Parallelism is implementation-defined. The kernel may resolve independent leaves
concurrently; the snapshot is deterministic regardless of resolution order,
because the source-of-truth is the DAG, not the wall-clock arrival of resolved
values.

## Cycle detection

Cycles in the DAG are rejected at validation time.

- The kernel runs a depth-first search over the DAG. The first back-edge
  encountered surfaces a cycle.
- The error code is `invalid_argument` (closed `DomainErrorCode` enum). The
  error payload includes the cycle path: `a -> b -> c -> a`.
- A self-reference (`a -> a`, where component `a` references its own output) is
  a cycle of length one and is rejected with the same error code.

The kernel does not implement partial-cycle resolution. A manifest with any
cycle is unprocessable until the operator removes it.

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

The first two are static manifest errors and surface to the operator
synchronously. The third is a dynamic dependency the kernel resolves on the
operator's behalf.

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

The kernel processes `$$` once during validation; nested escapes (`$$$$`)
collapse pairwise.

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
