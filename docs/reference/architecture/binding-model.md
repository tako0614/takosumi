# バインディングモデル {#link-and-projection-model}

Component kind が定義する resource 配線は Link intent を作る。current manifest では `components.<name>.listen` edge から発生する。manifest author は `listen.from` で source を選び、`listen.as` で injection mode を選ぶ。 resolved access mode は operator policy、publish の出力の declaration、consumer slot metadata から resolution 中に決まる。Link は 1 つの Space の中で consumer slot を producer output または PlatformServiceDeclaration snapshot に接続する。

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
    - authorization
    - secret
  effectDetailsDigest: sha256:...
  selectedImplementation: implementation:...
  policyDecisionRefs: []
```

ProjectionSelection は Link field として扱う internal selection record です。

## Space ルール {#space-rule}

current public manifest の Link は、consumer Object を same-manifest component publication または同じ Space に見える operator PlatformServiceDeclaration に接続する。 Space を跨ぐ Link は operator-internal / future sharing model であり、manifest v1 から直接作る construct ではない。

## Projection ファミリ {#projection-families}

```text
env
secret-env
upstream
config-mount
```

Secret の publish の出力はプレーンな `env` に projection してはならない。 `upstream` は gateway / ingress kind が `listen` した HTTP 出力データを kind-specific route rule から参照する injection mode です。`routes[].to` は `listen` binding name を指し、別の route graph や public URL assignment を作る field ではありません。 `http-endpoint` は injection mode ではなく output type です。 Operator distribution は独自の injection mode を追加できます。その family を portable official catalog term として扱う場合は、type catalog に意味と出力データの compatibility を追加します。`file-secret`、`runtime-capability`, `volume-mount` のような implementation-specific families は operator extension です。portable official catalog term として使うには type catalog で定義します。

## Compatibility check {#compatibility-check}

Link resolution は resource side effect の前に次を検証します。

1. `listen.from` が same-manifest の publish の出力か Space-visible PlatformServiceDeclaration に exact match する。
2. source の output type alias / URI が解決済みで、出力データの metadata、 publish の出力の declaration、operator policy、または採用済み kind の定義から version / sensitivity 相当の判断材料が取得できる。
3. `listen.as` injection mode が source output type で許可される。
4. PlatformServiceDeclaration 由来の場合、resolved access mode が publish の出力の `accessModes` と operator policy で許可される。
5. publisher role、materialization evidence、operator policy、採用済み kind の定義が requested projection を許可する。特に `http-endpoint` を `listen.as: upstream` で受ける場合は、source が upstream として再利用可能かを backend / operator policy / kind の定義で確認する。
6. secret / restricted 出力データを plain env や public URL へ落とす unsafe projection は fail-closed で拒否する。

成功した selection は Deployment に紐づく deploy evidence に、publish の出力 / そのスナップショット、output type、projection family、access mode として記録されます。

## Access の既定値 {#access-defaults}

credential や authorization の出力データを生み出す publish の出力は、その publish が `safeDefaultAccess` を宣言していない限り operator policy による明示的な access mode 選択を必要とする。closed な v1 access mode 語彙は [Kind Resolution Model — Access mode enum](./kind-resolution-model.md) にある。

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
  injection mode or shape changes

reauthorize:
  access mode or authorization details change

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

行は mutation、列は link の current state。各セルは mutation を適用したときの next state を記録する。`—` は mutation がその state で違法であることを意味する (resolution / plan は reject しなければならない)。`debt!` は mutation が [Drift Detection](../drift-detection.md) に従って `CleanupBacklog` レコードを queue しうることを意味する。

| mutation \\ state | pending       | materializing | materialized    | stale           | rematerializing | revoking | revoked | failed           | debt             |
| ----------------- | ------------- | ------------- | --------------- | --------------- | --------------- | -------- | ------- | ---------------- | ---------------- |
| rematerialize     | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| reproject         | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| reauthorize       | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| rewire            | materializing | —             | rematerializing | rematerializing | —               | —        | —       | rematerializing  | —                |
| revoke            | revoked       | —             | revoking        | revoking        | revoking        | —        | —       | revoking · debt! | —                |
| retain-generated  | —             | —             | materialized    | materialized    | —               | —        | —       | materialized     | —                |
| no-op             | pending       | materializing | materialized    | stale           | rematerializing | revoking | revoked | failed           | debt             |
| repair            | —             | —             | —               | —               | —               | —        | —       | rematerializing  | revoking · debt! |

注記:

- in-flight な state (`materializing`、`rematerializing`、`revoking`) を対象とする mutation は v1 では常に違法である。recovery は in-flight operation が `failed` または `debt` に着地した後に `repair` を経て進む。
- `failed` からの `revoke` と `debt` からの `repair` は外部 cleanup が完了できないときに CleanupBacklog を queue しうる。[Object Model](./object-model.md) の Object revoke flow を参照。
- `retain-generated` は [Approval invalidation triggers](./approval-model.md) をすべて満たす approval を伴うときのみ合法である。
- `no-op` は常に state を保ち、journal effect を出さない。
- 生成された子 object の lifecycle は [Object Model revoke participation matrix](./object-model.md) に従う。

## 衝突ルール {#collision-rules}

Link の projection が別の解決済み binding と衝突する場合、Takosumi は resolution の順序で precedence list を適用しなければならない。最初に一致したものが勝ち、先行 binding を上書きするような後続入力は resolution を失敗させる。

```text
1. literal target input field        (strongest)
2. environment variable already set on the target
3. runtime target declared by the target descriptor
4. mount path already declared by the target
5. reserved target name in the target's vocabulary
6. projection produced by this link  (weakest)
```

検知された衝突は [承認モデル](./approval-model.md) の `collision-detected` Risk として surface し、resolution が決定的な precedence の一致を提供しない限り fail-closed する。public v1 には manifest-level の override 機構は無い。operator 側の override を後で導入する場合、別の RFC で入れる。
