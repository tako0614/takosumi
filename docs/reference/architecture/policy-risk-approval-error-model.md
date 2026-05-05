# Policy, Risk, Approval, and Error Model

Policy turns Space, snapshot, and effect data into allow, deny, or approval
decisions.

## Policy outcomes

```text
allow
deny
require-approval
```

## Effect model

Policy must evaluate both family and details.

```yaml
effectFamilies:
  - secret
  - grant
  - network

effectDetails:
  secret:
    projectionFamily: secret-env
    rawValueStoredInCore: false
    updateBehavior: restart-required
  grant:
    access: read-write
    target: takos.database.primary
    credentialTtlSeconds: 3600
  network:
    egress:
      - host: db.example.com
        protocol: tcp
        port: 5432
```

## Space policy gates

Policy must evaluate Space membership and Space export sharing.

```text
space-resolution:
  Is the actor allowed to deploy in this Space?

namespace-scope-resolution:
  Is the export visible inside this Space?

cross-space-link:
  Is there an explicit SpaceExportShare or operator-approved import?

space-secret-projection:
  May this Space receive the secret projection?

space-artifact-use:
  May this Space read the DataAsset?
```

Cross-space access is denied by default.

## Risk kinds

The closed v1 Risk enum. New kinds require an RFC (CONVENTIONS.md §6).

```text
secret-projection
external-export
generated-credential
generated-grant
network-egress
traffic-change
stale-export
revoked-export
cross-scope-link
cross-space-link
shadowed-namespace
space-export-share
implementation-unverified
actual-effects-overflow
rollback-revalidation-required
revoke-debt-created
raw-secret-literal
collision-detected
transform-unapproved
```

`collision-detected` is raised by
[Link and Projection Model — Collision rules](./link-projection-model.md).
`transform-unapproved` is raised by
[DataAsset Model — Transform approval enforcement](./data-asset-model.md).
`stale-export` is raised by
[Space Model — SpaceExportShare lifecycle](./space-model.md) when a share has
expired. `revoke-debt-created` is raised when an operation queues a RevokeDebt
record per
[Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md).

## Approval lifecycle

```text
pending
approved
denied
expired
invalidated
consumed
```

Approval binds to:

```yaml
Approval:
  spaceId: space:acme-prod
  desiredSnapshotDigest: sha256:...
  operationPlanDigest: sha256:...
  riskItemIds: []
  approvedEffects: {}
  effectDetailsDigest: sha256:...
  actor: ...
  policyVersion: ...
  expiresAt: ...
```

## Approval invalidation triggers

The closed v1 set of triggers. Each trigger is independent; any one firing
invalidates the approval.

```text
1. digest change
   DesiredSnapshot digest or OperationPlan digest no longer matches
   the value the approval bound to.

2. effect-detail change
   approvedEffects, effectDetailsDigest, grant access, or network egress
   has changed since approval.

3. implementation change
   The selected Implementation for any operation has changed.

4. external freshness change
   An external ExportDeclaration or import (including SpaceExportShare)
   referenced by the snapshot is no longer fresh.

5. catalog release change
   The CatalogRelease adopted by the Space has changed.

6. Space-context change
   Space id, Space membership, Space policy pack, or any
   SpaceExportShare governing this resolution has changed.
```

## Error model

Every resolution or operation planning failure must return:

```yaml
Error:
  subject: link:api.DATABASE_URL
  reason: access-required
  candidates: []
  safeFix: []
  requiresPolicyReview: []
  operatorFix: []
```

Fix hints are classified. Access escalation, external links, and network
expansion must not be presented as safe fixes.

## Policy packs

Operators should select from policy packs and override only differences.

```text
dev/open
selfhost/simple
prod/default
prod/strict
enterprise/catalog-approved-only
```

## Approval flow architecture

### Approver UX states

approver が見る client 可視状態は approval lifecycle に対応します。

```text
pending     decision 待ち。approver inbox に表示
reviewing   approver が claim 済み。他の approver の重複作業を抑制
approved    approve 済みかつ未消化。binding する OperationPlan が apply 可能
denied      reject 済み。同 plan は再 propose しない限り再開不能
expired     expiresAt 経過。再 propose で新規 approval が必要
```

`reviewing` は client view にのみ存在する soft 状態で、kernel record は
`pending` のままです。claim 解除は idle timeout で自動失効します。

### Batching

1 つの OperationPlan が複数 Risk を発火させた場合、kernel は **plan 単位で 1
approval を発行** し、`riskItemIds[]` に該当 Risk を列挙します。Risk ごと に
individual approval を切らない理由は、approver が Risk 同士の relation
(secret-projection と grant が同 component に属する 等) を横断的に判断
する必要があるためです。closed enum 19 entries の Risk はすべてこの batching
で処理されます。

### Invalidation propagation

Approval invalidation triggers は 6 個の独立 trigger で、いずれか 1 つが
発火すれば approval 全体が `invalidated` 状態に遷移します。digest 系 (trigger
1, 2) は同一 plan 内の他 binding を再評価せずに **短絡 invalidate**
します。digest が変わったということは plan を全面 re-resolve する必要が
あり、partial valid を残すと approver が古い前提で承認した状態が混在する
ためです。trigger 3-6 は plan を保ったまま発火するため、kernel は影響範囲 を
minimum approval set に絞って propagate します。

### Cross-Space approvals

SpaceExportShare に紐づく approval は importing Space owner が approver
です。exporting Space には **通知のみ** が送られ、approve 権限は付与され
ません。これは [Space Model — SpaceExportShare lifecycle](./space-model.md)
の所有権モデル (importing Space が消費する責任を負う) に従っています。 exporting
Space owner は通知から share の利用状況を把握できますが、 approval flow
には介入しません。

## Error envelope philosophy (cross-link)

API surface 側の closed shape `{ code, message, requestId, details? }` と 本
model の Error fix-hint 分類 (safeFix / requiresPolicyReview / operatorFix)
は別レイヤで動作します。

- **error vs Risk**: Risk は plan 出力の判定点 (allow / deny / require-approval
  に分岐させる data)。Error は operation result の失敗理由 (resolution / apply /
  destroy が走り終わった後の outcome)。Risk は approve で吸収可能、 Error は再
  plan / 再 apply で解消する性質を持ちます。
- **fix-hint 生成 stage**: WAL の `prepare` stage で `safeFix[]` (manifest 上
  自動補正可能な提案) が、`pre-commit` stage で `requiresPolicyReview[]`
  (approval が要る昇格) が、`commit` / `post-commit` / `observe` / `finalize`
  stage で `operatorFix[]` (operator 介入が要る) が生成されます。 詳細 stage
  定義は
  [OperationPlan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
  を参照してください。
- access escalation / external link 拡張 / network egress 拡張は **safeFix
  に載せない** という invariant は API envelope の自動分類でも維持されます。

## Cross-references

- Architecture: [API Surface Architecture](./api-surface-architecture.md)
- Architecture:
  [OperationPlan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- Architecture: [Space Model](./space-model.md)
- Architecture:
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
- Reference: [Kernel HTTP API](/reference/kernel-http-api)
- Reference: [Runtime-Agent API](/reference/runtime-agent-api)
