# Link and Projection Model

Shape-defined resource wiring creates Link intent. In the public manifest this
comes from fields such as `resources[].spec.bindings` and `${ref:...}` /
`${secret-ref:...}` values, not from a separate top-level `uses` object. A Link
connects a consumer slot to a producer output or ExportDeclaration snapshot
inside one Space.

## Link record

```yaml
Link:
  spaceId: space:acme-prod
  id: link:api.DATABASE_URL
  consumer: object:api
  slot: DATABASE_URL
  sourceExportSnapshotId: export-snapshot:takos.database.primary@...
  sourceSpaceId: space:acme-prod
  access: read-write
  selectedProjection:
    family: secret-env
    name: DATABASE_URL
    updateBehavior: restart-required
  effectFamilies:
    - grant
    - secret
  effectDetailsDigest: sha256:...
  selectedImplementation: implementation:...
  policyDecisionRefs: []
```

ProjectionSelection is a Link field, not a public manifest object.

## Space rule

A Link normally connects a consumer Object to an ExportDeclaration in the same
Space. Cross-space links are denied unless the ResolutionSnapshot records an
explicit SpaceExportShare or operator-approved namespace import.

Cross-space links must appear in plan risk output and approval binding.

## Projection families

```text
env
secret-env
file-secret
runtime-capability
sdk-config
http-client-config
service-endpoint
volume-mount
```

Secret exports must not project to plain `env`.

## Access defaults

Grant-producing exports require explicit `access` unless the export declares
`safeDefaultAccess`. The closed v1 access mode vocabulary lives in
[Target Model — Access mode enum](./target-model.md).

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
```

## Link mutation

The closed v1 set of Link mutations:

```text
rematerialize:
  same source / access / projection, refresh material

reproject:
  projection family or shape changes

regrant:
  access mode or grant details change

rewire:
  source export changes

revoke:
  link removed; generated material revoked

retain-generated:
  generated material retained with approval after a rewire / revoke

no-op:
  resolution determined no change is required for this link

repair:
  recovery-driven mutation that reconciles a link from `failed` or `debt`
  back to a healthy state without changing source / access / projection
```

No new mutation kinds without RFC (CONVENTIONS.md §6).

## Link mutation × state transition

Rows are mutations, columns are the link's current state. Each cell records the
next state when the mutation is applied. `—` means the mutation is illegal in
that state (resolution / plan must reject). `debt!` means the mutation may queue
a `RevokeDebt` record per
[Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md).

| mutation \\ state | pending       | materializing | materialized    | stale           | rematerializing | revoking | revoked | failed           | debt             |
| ----------------- | ------------- | ------------- | --------------- | --------------- | --------------- | -------- | ------- | ---------------- | ---------------- |
| rematerialize     | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| reproject         | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| regrant           | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| rewire            | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| revoke            | revoked       | —             | revoking        | revoking        | revoking        | —        | —       | revoking · debt! | —                |
| retain-generated  | —             | —             | materialized    | materialized    | —               | —        | —       | materialized     | —                |
| no-op             | pending       | materializing | materialized    | stale           | rematerializing | revoking | revoked | failed           | debt             |
| repair            | —             | —             | —               | —               | —               | —        | —       | rematerializing  | revoking · debt! |

Notes:

- A mutation that targets an in-flight state (`materializing`,
  `rematerializing`, `revoking`) is always illegal in v1; recovery proceeds via
  `repair` after the in-flight operation lands in `failed` or `debt`.
- `revoke` from `failed` and `repair` from `debt` may queue a RevokeDebt when
  external cleanup cannot complete; see Object revoke flow in
  [Object Model](./object-model.md).
- `retain-generated` is only legal when accompanied by an approval that
  satisfies all
  [Approval invalidation triggers](./policy-risk-approval-error-model.md).
- `no-op` always preserves state and emits no journal effects.
- Generated child object lifecycle follows the
  [Object Model revoke participation matrix](./object-model.md).

## Collision rules

When a Link projection would collide with another resolved binding, the kernel
must apply the precedence list in resolution order. The first match wins; later
inputs that would overwrite an earlier binding fail the resolution.

```text
1. literal target input field        (strongest)
2. environment variable already set on the target
3. runtime binding declared by the target descriptor
4. mount path already declared by the target
5. reserved target name in the target's vocabulary
6. projection produced by this link  (weakest)
```

Detected collisions surface as the `collision-detected` Risk in
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
and fail-closed unless the resolution provides a deterministic precedence match.
Public v1 has no manifest-level override mechanism. Operator-side overrides, if
introduced later, must enter through a separate RFC.
