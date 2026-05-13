# Observation, Drift, and RevokeDebt Model

> このページでわかること: observation / drift / RevokeDebt のモデル定義。

Observation は Space 内の reality を記録する。Drift は計算される。Debt は失敗
した cleanup を記録する。

## ObservationSet

```yaml
ObservationSet:
  spaceId: space:acme-prod
  desiredSnapshotId: desired:...
  observedAt: ...
  observations:
    object:api:
      state: present | missing | degraded | unknown
    link:api.DATABASE_URL:
      state: materialized | stale | failed
    export:takos.database.primary:
      freshness: fresh | stale | revoked | unknown
```

ObservationSet は DesiredSnapshot を変更しない。

## Space rule

ObservationSet、DriftIndex、RevokeDebt は Space scope である。ある Space の
observation は別 Space の DesiredSnapshot を変更したり validate したりしては
ならない。current v1 は Space を跨ぐ share debt を作らない。将来の RFC で
provider Space を有効化する場合も、記録された share 経由でのみアクセスする。

## DriftIndex

DriftIndex は DesiredSnapshot と ObservationSet を比較する。

```yaml
Drift:
  address: link:api.DATABASE_URL
  kind: stale-secret-projection
  severity: warning | error
  detectedAt: ...
```

## RevokeDebt

RevokeDebt は revoke または削除すべきだが cleanup できなかった生成 material を
記録する。

### RevokeDebt record schema

```yaml
RevokeDebt:
  id: revoke-debt:...
  generatedObjectId: generated:link:api.DATABASE_URL/grant
  sourceExportSnapshotId: export-snapshot:...
  externalParticipantId: db-platform
  reason: external-revoke
  status: open
  ownerSpaceId: space:acme-prod
  originatingSpaceId: space:acme-prod
  retryPolicy: {}
  createdAt: ...
```

closed な v1 enum:

```text
reason:
  external-revoke         external system rejected or could not acknowledge
  link-revoke             link revoke could not complete cleanly
  activation-rollback     activation rolled back but cleanup is pending
  approval-invalidated    a previously approved retain became invalid
  cross-space-share-expired

status:
  open                    debt is queued and will be retried
  operator-action-required
                          retry is exhausted or blocked; operator must act
  cleared                 debt is satisfied; entry is preserved for audit
```

### Ownership fields

RevokeDebt は cleanup / retry を実行する Space が所有する。current v1 は
次の語彙を使う。

- `ownerSpaceId` drives retry, status transitions, cleanup, and worker context.
- `originatingSpaceId` records where the debt originated; omitted values default
  to `ownerSpaceId`.
- status mutation is scoped to `ownerSpaceId`.

### ActivationSnapshot propagation

`status: operator-action-required` は ActivationSnapshot state に伝播するが、
fail-safe-not-fail-closed である。

- 関連する debt が `operator-action-required` の間、新規 traffic shift
  (GroupHead を進める activation) は block される。
- 既存の GroupHead pointer と TrafficAssignment は自動的に rollback
  **されない**。 runtime は以前の assignment を提供し続ける。
- observation で `unhealthy` 注記と debt がどう相互作用するかは
  [Exposure and Activation Model — Post-activate health state](./exposure-activation-model.md)
  を参照。

RevokeDebt は警告ではない。operational debt であり、status、plan、audit、
production readiness check で可視でなければならない。

## Observation retention

ObservationSet は最新の reality を保存する。ObservationHistory は optional で
policy 管理。OperationJournal と RevokeDebt は recovery クリティカルな履歴を
持つ。

## Observability architecture

この節は observation / drift / debt が operator から見える signal になるまでを
規律するアーキテクチャ層の規則を記録する。wire shape は reference 文書にある。

### Audit retention policy

retention は階層的である。各層は別個の目的と TTL 境界を持つ。

```text
ObservationSet         latest reality only; superseded by next observation
ObservationHistory     optional; opt-in retention of past ObservationSet entries
OperationJournal       recovery-critical; retained until journal compaction allows it
AuditLog               compliance-driven; retained per operator policy
```

アーキテクチャ規則:

- TTL は kernel が固定しない。各層は operator 管理の retention policy を持つ。
- 後続の ObservationSet が存在する限り ObservationSet は自由に破棄できる。
- 依存する RevokeDebt が非終了状態にある間、または WAL replay の正しさが依存
  している間は、OperationJournal entry を破棄してはならない。
- AuditLog retention は他 3 つから独立している。compliance window が
  OperationJournal retention を短くすることはない。

### Drift propagation

drift entry はまず `DriftIndex` に surface する。そこから固定 path に沿って
伝播する。

```text
DriftIndex
  -> ActivationSnapshot annotation     drift annotates the relevant activation entry
  -> status surface                    operator status / plan / preview reflects the drift
  -> approval invalidation             see Approval invalidation triggers in policy-risk-approval-error-model
```

DriftIndex は DesiredSnapshot を変更しない。drift による activation rollback は
RevokeDebt と activation lifecycle が仲介し、DesiredSnapshot を直接編集する
ことはない。

### RevokeDebt aging

`status: open` のまま aging window を過ぎた RevokeDebt は、自動的に
`operator-action-required` に遷移する。

```text
open --(aging window elapsed without retry success)--> operator-action-required
```

Aging のアーキテクチャ規則:

- aging window は policy 管理であり、kernel 定数ではない。アーキテクチャは
  そのような window が存在し、遷移が自動・idempotent・journal 済みであること
  だけを要求する。
- 手動 operator action は window によらず `open` から `operator-action-required`
  に直接遷移できる。
- `cleared` は終端である。aged debt が clear されたときは aging 遷移と clearance
  event の両方を記録する。

### ObservationHistory policy

ObservationHistory は optional で Space scope である。

```text
opt-in    operator enables retention; ObservationSet entries are appended to history
opt-out   default; only the latest ObservationSet is kept
```

アーキテクチャ規則:

- ObservationHistory は resolution や planning の authority にはならない。query
  surface に過ぎない。
- ObservationHistory を有効化しても DriftIndex の semantics は変わらない。drift
  は current ObservationSet と DesiredSnapshot を比較して計算される。
- ObservationHistory を無効化しても OperationJournal や RevokeDebt record を
  削除してはならない。

## Cross-references

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
- [Exposure and Activation Model](./exposure-activation-model.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
