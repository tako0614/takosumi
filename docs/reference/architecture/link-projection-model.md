# Link と Projection モデル {#link-and-projection-model}

Component kind が定義する resource 配線は Link intent を作る。current AppSpec
では `components.<name>.listen` edge から発生する。AppSpec author は
`listen.from` で source を選び、`listen.as` で projection family を選ぶ。
resolved access mode は operator policy、publication declaration、consumer slot
metadata から resolution 中に決まる。Link は 1 つの Space の中で consumer slot
を producer output または ExternalPublicationDeclaration snapshot に接続する。

## Link レコード {#link-record}

```yaml
Link:
  spaceId: space_acme_prod
  id: link_api_DATABASE_URL
  consumer: obj_api
  slot: DATABASE_URL
  sourcePublicationSnapshotId: pubsnap_publisher.database.primary@...
  sourceSpaceId: space_acme_prod
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

ProjectionSelection は Link field として扱う internal selection record です。

## Space ルール {#space-rule}

current public AppSpec の Link は、consumer Object を same-AppSpec component
publication または同じ Space に見える operator ExternalPublicationDeclaration
に接続する。 Space を跨ぐ Link は operator-internal / future sharing model
であり、AppSpec v1 から直接作る construct ではない。

## Projection ファミリ {#projection-families}

```text
env
secret-env
upstream
config-mount
```

Secret publication はプレーンな `env` に projection してはならない。 `upstream`
は gateway / ingress kind が `listen` した HTTP material を kind-specific route
rule から参照する projection family です。`routes[].to` は `listen` binding name
を指し、別の route graph や public URL assignment を作る field ではありません。
`http-endpoint` は projection family ではなく material contract です。 Operator
distribution は独自の projection family を追加できます。その family を portable
official catalog term として扱う場合は、type catalog に意味と material
compatibility を追加します。`file-secret`、`runtime-capability`, `volume-mount`
のような implementation-specific families は operator extension です。portable
official catalog term として使うには type catalog で定義します。

## Compatibility check {#compatibility-check}

Link resolution は provider side effect の前に次を検証します。

1. `listen.from` が same-AppSpec publication か Space-visible
   ExternalPublicationDeclaration に exact match する。
2. source の material contract alias / URI が解決済みで、material metadata、
   publication declaration、operator policy、または採用済み descriptor metadata
   から version / sensitivity 相当の判断材料が取得できる。
3. `listen.as` projection family が source material contract で許可される。
4. ExternalPublicationDeclaration 由来の場合、resolved access mode が
   publication の `accessModes` と operator policy で許可される。
5. publisher role、materialization evidence、operator policy、採用済み
   descriptor metadata が requested projection を許可する。特に `http-endpoint`
   を `listen.as: upstream` で受ける場合、source が upstream
   として再利用可能かを provider / operator policy / descriptor metadata
   で確認する。
6. secret / restricted material を plain env や public URL へ落とす unsafe
   projection は fail-closed で拒否する。

成功した selection は Deployment に紐づく retained implementation/operator
evidence に、publication / publication snapshot、material contract、projection
family、access mode として記録されます。

## Access の既定値 {#access-defaults}

grant を生み出す publication は、publication が `safeDefaultAccess`
を宣言していない限り operator policy による明示的な access mode
選択を必要とする。closed な v1 access mode 語彙は
[Kind Resolution Model — Access mode enum](./kind-resolution-model.md) にある。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  api:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      database:
        from: db.connection
        as: secret-env
        prefix: DATABASE
```

## Link の mutation {#link-mutation}

v1 で closed な Link mutation 集合:

```text
rematerialize:
  same source / access / projection, refresh material

reproject:
  projection family or shape changes

regrant:
  access mode or grant details change

rewire:
  source publication changes

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

## Link mutation ×状態遷移 {#link-mutation--state-transition}

行は mutation、列は link の current state。各セルは mutation を適用したときの
next state を記録する。`—` は mutation がその state で違法であることを意味する
(resolution / plan は reject しなければならない)。`debt!` は mutation が
[Drift Detection](../drift-detection.md) に従って `RevokeDebt` レコードを queue
しうることを意味する。

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

## 衝突ルール {#collision-rules}

Link の projection が別の解決済み binding と衝突する場合、kernel は resolution
の順序で precedence list を適用しなければならない。最初に一致したものが勝ち、
先行 binding を上書きするような後続入力は resolution を失敗させる。

```text
1. literal target input field        (strongest)
2. environment variable already set on the target
3. runtime target declared by the target descriptor
4. mount path already declared by the target
5. reserved target name in the target's vocabulary
6. projection produced by this link  (weakest)
```

検知された衝突は
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
の `collision-detected` Risk として surface し、resolution が決定的な precedence
の一致を提供しない限り fail-closed する。public v1 には AppSpec-level の
override 機構は無い。operator 側の override を後で導入する場合、別の RFC で
入れる。
