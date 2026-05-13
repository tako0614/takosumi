# Object Model

> このページでわかること: kernel の object model とエンティティ関係。

Object は kernel graph の canonical entity である。すべての Object は厳密に 1
つの Space に属する。public な `resources[]` entry は Object intent となり、
その後 resolved な Object になる。

## Space-qualified identity

Object のアドレスは Space 内で一意である。storage は identity を tuple として
扱うべきである。

```text
(spaceId, objectAddress)
```

qualified な表示形式は log や plan で許される。

```text
space:acme-prod/object:api
```

ある Space の Object を別の Space の authority として更新・削除・observe する
ことは決して許されない。

## Object lifecycle classes

```text
managed:
  Takosumi may create, update, replace, delete.

generated:
  Created by a Link, Exposure, DataAsset transform, composite target, or operation.
  Must carry owner, reason, delete policy, and deterministic identity.

external:
  Owned outside Takosumi. Takosumi may verify, observe, link, and request grants.
  Takosumi must not create or delete it.

operator:
  Owned by operator platform. User deployment may link to approved exports.
  User deployment must not delete it.

imported:
  Existing object registered by operator policy. Delete is denied unless explicitly approved.
```

## Object record

```yaml
Object:
  spaceId: space:acme-prod
  address: object:api
  lifecycleClass: managed
  shape: web-service@v1
  provider: "@takos/cloudflare-workers"
  targetDescriptorDigest: sha256:...
  owner:
    kind: deployment
    id: deployment:...
  desiredGeneration: 3
  labels: {}
```

## Generated object requirements

すべての generated object は以下を持つ。

```yaml
GeneratedObject:
  address: generated:link:api.DATABASE_URL/grant
  owner: link:api.DATABASE_URL
  reason: link-materialization
  deterministicId: sha256:...
  deletePolicy: delete-with-owner | retain-with-approval | revoke-with-owner
  lifecycleClass: generated
```

生成 object の identity は side effect が始まる前に記録される。

## Object revoke flow

Revoke は managed または generated object をその不在で置き換える lifecycle で、
外部制約を尊重する。state machine は次の通り。

```text
live → revoking → revoked
            \
             → debt          (revoke could not complete cleanly)
```

revoke 参加は lifecycle class で制限される。`external-source` と
`external-participant` (下表の `external` と `operator` 行) は revoke target と
してこの flow に入ってはならず、その generated child だけが対象となる。これは
[Invariant-first Root Model](./invariant-first-root-model.md) の external
ownership invariant の再宣言である。

外部 cleanup が必要で外部システムが revoke を reject または ack できなかった
とき、link の owner は
[Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
に従って `RevokeDebt` record を queue し、object は debt が clear されるまで
`debt` state に入る。

## Revoke participation matrix

行は object の lifecycle class、列は object を tear down する際に関わる 4 つ の
operation。`yes` は許可、`gen-only` は object 自身ではなく generated child
にのみ許可、`no` は禁止、`debt-on-fail` は外部 cleanup の失敗が `RevokeDebt` を
queue するかどうかを表す。

| Lifecycle class | delete             | revoke             | detach       | debt-on-fail |
| --------------- | ------------------ | ------------------ | ------------ | ------------ |
| managed         | yes                | yes                | yes          | yes          |
| generated       | by owner operation | by owner operation | yes          | yes          |
| external        | no                 | gen-only           | yes          | gen-only     |
| operator        | no                 | gen-only           | policy-gated | gen-only     |
| imported        | policy-gated       | gen-only           | yes          | gen-only     |

`detach` は source object を変更せずに consumer 側の reference (Link または
Exposure) を取り除く。policy で明示的に gate されない限り、常に合法である。

## Operation restrictions

lifecycle class は operation 種別を制限する。Space containment も operation
種別を制限する。

| Lifecycle class | Create/update/delete  | Verify/observe | Link/materialize | Revoke generated child  |
| --------------- | --------------------- | -------------- | ---------------- | ----------------------- |
| managed         | yes                   | yes            | yes              | yes                     |
| generated       | by owner operation    | yes            | yes              | yes                     |
| external        | no                    | yes            | yes              | generated children only |
| operator        | no by user deployment | yes            | policy-gated     | generated children only |
| imported        | policy-gated          | yes            | yes              | generated children only |
