# Link and Projection Model

> このページでわかること: link と projection のモデル定義。

Shape が定義する resource 配線は Link intent を作る。public manifest では
`resources[].spec.bindings` のような field や `${ref:...}` / `${secret-ref:...}`
値から発生し、別の top-level `uses` object からは作られ ない。Link は 1 つの
Space の中で consumer slot を producer output または ExportDeclaration snapshot
に接続する。

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

ProjectionSelection は Link field であり、public manifest object ではない。

## Space rule

Link は通常、consumer Object を同じ Space の ExportDeclaration に接続する。
Space を跨ぐ Link は明示的な Space export 共有と approval binding を要求する。

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

Secret export はプレーンな `env` に projection してはならない。

## Access defaults

grant を生み出す export は、export が `safeDefaultAccess` を宣言していない限り
明示的な `access` を必要とする。closed な v1 access mode 語彙は
[Target Model — Access mode enum](./target-model.md) にある。

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

v1 で closed な Link mutation 集合:

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

RFC (CONVENTIONS.md §6) なしに新規 mutation 種別を追加しない。

## Link mutation × state transition

行は mutation、列は link の current state。各セルは mutation を適用したときの
next state を記録する。`—` は mutation がその state で違法であることを意味する
(resolution / plan は reject しなければならない)。`debt!` は mutation が
[Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
に従って `RevokeDebt` レコードを queue しうることを意味する。

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

注記:

- in-flight な state (`materializing`、`rematerializing`、`revoking`) を対象と
  する mutation は v1 では常に違法である。recovery は in-flight operation が
  `failed` または `debt` に着地した後に `repair` を経て進む。
- `failed` からの `revoke` と `debt` からの `repair` は外部 cleanup が完了でき
  ないときに RevokeDebt を queue しうる。[Object Model](./object-model.md) の
  Object revoke flow を参照。
- `retain-generated` は
  [Approval invalidation triggers](./policy-risk-approval-error-model.md) を
  すべて満たす approval を伴うときのみ合法である。
- `no-op` は常に state を保ち、journal effect を出さない。
- 生成された子 object の lifecycle は
  [Object Model revoke participation matrix](./object-model.md) に従う。

## Collision rules

Link の projection が別の解決済み binding と衝突する場合、kernel は resolution
の順序で precedence list を適用しなければならない。最初に一致したものが勝ち、
先行 binding を上書きするような後続入力は resolution を失敗させる。

```text
1. literal target input field        (strongest)
2. environment variable already set on the target
3. runtime binding declared by the target descriptor
4. mount path already declared by the target
5. reserved target name in the target's vocabulary
6. projection produced by this link  (weakest)
```

検知された衝突は
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
の `collision-detected` Risk として surface し、resolution が決定的な precedence
の一致を提供しない限り fail-closed する。public v1 には manifest-level の
override 機構は無い。operator 側の override を後で導入する場合、別の RFC で
入れる。
