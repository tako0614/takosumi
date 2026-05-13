# Operation Plan and Write-ahead Journal Model

> このページでわかること: operation plan と WAL のモデル定義。

OperationPlan は 1 つの Space 内で derived される work である。
WriteAheadOperationJournal は実行の authority である。

## OperationPlan

OperationPlan は同じ Space の `DesiredSnapshot` と `ObservationSet` から derive
される。

含まれる operation の例:

```text
apply-object
delete-object
verify-object
materialize-link
rematerialize-link
revoke-link
prepare-exposure
activate-exposure
transform-data-asset
observe
compensate
```

OperationPlan は canonical な desired state ではない。

## Write-ahead journal

side-effect を持つ operation はこの形に従う。

```text
operation-intent-recorded
generated-object-planned
external-call-started
generated-object-observed
operation-completed
```

失敗時:

```text
operation-failed
compensation-started
compensation-completed | compensation-failed
revoke-debt-created when needed
```

## Stage enumeration

各 journal entry は closed v1 enum から `stage` を持つ。stage は成功 operation
では以下の順序で進む。`abort` と `skip` は forward stage を置き換えうる終端
stage である。

```text
prepare      → pre-commit → commit → post-commit → observe → finalize
                                       \
                                        → abort     (no further stages)
                                        → skip      (no-op resolution)
```

| stage       | may write actual-effects | may queue RevokeDebt | may re-validate approval |
| ----------- | ------------------------ | -------------------- | ------------------------ |
| prepare     | no                       | no                   | yes                      |
| pre-commit  | no                       | no                   | yes                      |
| commit      | yes                      | no                   | no                       |
| post-commit | yes                      | yes                  | no                       |
| observe     | no                       | yes                  | no                       |
| finalize    | no                       | no                   | no                       |
| abort       | no                       | yes                  | no                       |
| skip        | no                       | no                   | no                       |

`pre-commit` は transform approval gate
([DataAsset Model](./data-asset-model.md) 参照) と
[Link and Projection Model](./link-projection-model.md) が上げる衝突 risk の
canonical な enforcement point である。`post-commit` は live object を変更
しうる唯一の stage である。外部 cleanup が完了できないとき、debt はここまたは
`observe` から queue される。新規 stage は RFC (CONVENTIONS.md §6) を要する。

## Idempotency keys

各 journal entry は決定的な idempotency key を持つ。

```text
idempotencyKey = (spaceId, operationPlanDigest, journalEntryId)
```

この 3 つ組は Space の WAL 内で一意である。replay 時、同じ 3 つ組は決定的に 同じ
operation を再適用する。同じ `(spaceId, operationPlanDigest, journalEntryId)`
で来た replay の effect digest が以前に記録された entry と一致しない場合、kernel
は operation を hard-fail させ stage を進めない。その場合の recovery は新しい
`operationPlanDigest` (新規 OperationPlan) を発行しなければならない。

## Pre/post-commit verification

CatalogRelease は pre-commit と post-commit で kernel 所有の verification を
要求しうる。kernel は catalog が宣言する実行可能 hook package を実行しない。
Verification lifecycle:

```text
1. discovery        — active CatalogRelease descriptor selected by Space policy
2. invocation       — verifier runs in the corresponding stage above
3. result recorded  — verification outcome is journaled as evidence
4. fail-closed      — pre-commit failure aborts before provider effects;
                      post-commit failure records RevokeDebt and continues
                      observe/finalize evidence
```

Verification は policy または approval 再検証を bypass してはならない。
RevokeDebt を発行できるのは `post-commit` または `observe` stage からのみで
ある。

## Journal entries

```yaml
JournalEntry:
  spaceId: space:acme-prod
  journalId: journal:...
  operationId: operation:...
  deploymentId: deployment:...
  desiredSnapshotId: desired:...
  operationPlanDigest: sha256:...
  stage: operation-intent-recorded
  idempotencyKey: ...
  desiredGeneration: 7
  approvedEffects: {}
  timestamp: ...
```

## Deterministic generated ids

生成 object の id は外部呼び出しの前に計算されるべきである。

```text
grant id = hash(spaceId, deploymentId, linkId, exportSnapshotId, accessMode)
secret projection id = hash(spaceId, deploymentId, linkId, projectionName)
ingress reservation id = hash(spaceId, groupId, exposureId, host, path)
```

## Actual effects overflow

`actualEffects` が `approvedEffects` を超えた場合:

```text
1. journal overflow
2. pause operation
3. compensate when possible
4. require approval or fail
5. create debt if compensation cannot complete
```

## Space isolation

OperationPlan、OperationJournal、生成 object id、compensation record、
RevokeDebt は厳密に 1 つの Space に属する。ある Space の journal entry を別
Space の recovery authority として使ってはならない。

Space-global な state を変更する critical operation は Space 単位で直列化され、
global ingress 予約は operator-level の追加直列化を要しうる。

## OperationJournal retention

OperationJournal は side-effect と recovery の履歴を保持する。アクティブな 生成
object、未解決の compensation、未解決の revoke debt、現在の activation に
関連する entry は compaction で消してはならない。

別 store が保持しうるもの:

```text
AuditLog
ObservationHistory
CurrentStateIndex
```
