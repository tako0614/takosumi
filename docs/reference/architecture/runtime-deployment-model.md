# Runtime Deployment モデル {#runtime-deployment-model}

> このページでわかること: Operation Plan / Write-Ahead Journal と
> Invariant-First Root の設計原則 (= runtime deployment mechanics の正本)。

## Operation Plan と Write-Ahead Journal {#operation-plan--write-ahead-journal}

OperationPlan は 1 つの Space 内で derived される work である。
WriteAheadOperationJournal は実行の authority である。

### OperationPlan {#operationplan}

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

### Write-ahead journal {#write-ahead-journal}

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

### Stage 列挙 {#stage-enumeration}

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
([Data Asset Model](./namespace-export-model.md#data-asset-model) 参照) と
[Link and Projection Model](./link-projection-model.md) が上げる衝突 risk の
canonical な enforcement point である。`post-commit` は live object を変更
しうる唯一の stage である。外部 cleanup が完了できないとき、debt はここまたは
`observe` から queue される。新規 stage は RFC (CONVENTIONS.md §6) を要する。

### 冪等性キー {#idempotency-keys}

各 journal entry は決定的な idempotency key を持つ。

```text
idempotencyKey = (spaceId, operationPlanDigest, journalEntryId)
```

この 3 つ組は Space の WAL 内で一意である。replay 時、同じ 3 つ組は決定的に 同じ
operation を再適用する。同じ `(spaceId, operationPlanDigest, journalEntryId)`
で来た replay の effect digest が以前に記録された entry と一致しない場合、kernel
は operation を hard-fail させ stage を進めない。その場合の recovery は新しい
`operationPlanDigest` (新規 OperationPlan) を発行しなければならない。

### Pre/post-commit の verification {#prepost-commit-verification}

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

### Journal エントリ {#journal-entries}

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

### 決定的な生成 id {#deterministic-generated-ids}

生成 object の id は外部呼び出しの前に計算されるべきである。

```text
grant id = hash(spaceId, deploymentId, linkId, exportSnapshotId, accessMode)
secret projection id = hash(spaceId, deploymentId, linkId, projectionName)
ingress reservation id = hash(spaceId, groupId, exposureId, host, path)
```

### Actual effects オーバーフロー {#actual-effects-overflow}

`actualEffects` が `approvedEffects` を超えた場合:

```text
1. journal overflow
2. pause operation
3. compensate when possible
4. require approval or fail
5. create debt if compensation cannot complete
```

### Space 隔離 {#space-isolation}

OperationPlan、OperationJournal、生成 object id、compensation record、
RevokeDebt は厳密に 1 つの Space に属する。ある Space の journal entry を別
Space の recovery authority として使ってはならない。

Space-global な state を変更する critical operation は Space 単位で直列化され、
global ingress 予約は operator-level の追加直列化を要しうる。

### OperationJournal の保持 {#operationjournal-retention}

OperationJournal は side-effect と recovery の履歴を保持する。アクティブな 生成
object、未解決の compensation、未解決の revoke debt、現在の activation に
関連する entry は compaction で消してはならない。

別 store が保持しうるもの:

```text
AuditLog
ObservationHistory
CurrentStateIndex
```

## Invariant-First Root モデル {#invariant-first-root-model}

Takosumi v1 は単に graph-shaped であるだけでなく、**invariant-first** である。
graph は形を与え、invariant が operation を安全に保つ。

### 北極星 {#north-star}

```text
Takosumi v1 is an invariant-first, space-isolated, snapshot-backed,
graph-shaped, write-ahead-operation-journaled PaaS operation kernel.
```

AppSpec は authoring 入力である。deployment は Space の中で resolve される。
deployment は immutable な snapshot 群、operation journal、observation の
集合である。

### Root パイプライン {#root-pipeline}

```text
Manifest + Space context
  -> IntentGraph
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> ObservationSet
  -> ActivationSnapshot / GroupHead
```

### 必須 invariant

#### 1. Authority invariant

Apply、activate、rollback、destroy は記録された `ResolutionSnapshot` と
`DesiredSnapshot` を使わなければならない。live descriptor URL、live namespace
registry、再計算した semantics を authority として使ってはならない。

#### 2. Snapshot invariant

`ResolutionSnapshot` と `DesiredSnapshot` は immutable である。新しい意味または
desired graph は新しい snapshot を作る。

#### 3. Identity invariant

すべての `Object`、`ExportDeclaration`、`Link`、`Exposure`、`DataAsset`、
`Operation`、generated object、activation item は安定したアドレスを持つ。

#### 4. Ownership invariant

lifecycle class は operation を制限する。

```text
managed:
  may be created, updated, replaced, deleted by the deployment

generated:
  owned by an Object, Link, Exposure, DataAsset, or Operation
  must have owner, reason, deterministic id, and delete policy

external:
  may be verified, observed, linked, and granted
  must not be created or deleted by the deployment

operator:
  controlled by operator policy
  user deployment must not delete it

imported:
  pre-existing object registered by operator policy
  delete is denied unless explicitly operator-approved
```

この invariant を強制する revoke flow は
[Object Model — Object revoke flow](./object-model.md) に詳しい。

#### 5. Secret invariant

raw secret 値は core canonical state に保存されない。core state には secret
reference、handle、projection metadata、audit event を保存できる。

#### 6. Effects invariant

implementation は `approvedEffects` を超えてはならない。`actualEffects` が
approved effect を超えた場合、実行は一時停止し、overflow を journal し、可能なら
compensation を実行し、承認を要求するか fail しなければならない。

#### 7. Write-ahead journal invariant

side-effect を持つ operation は side effect の前に intent を記録しなければなら
ない。生成 object identity は外部呼び出しの前に計画されなければならない。観測
された handle は外部呼び出しの後に append されなければならない。

#### 8. Idempotency invariant

retry は同じ intent である。生成 object identity は、deployment id、link id、
export snapshot id、access mode、exposure id、desired generation のような安定
した入力から決定的に決まるべきである。

#### 9. Activation invariant

Apply と activation は分離されている。GroupHead と traffic assignment は apply
phase の再検証後にのみ移動する。

#### 10. Observation invariant

Observation は reality を記録する。Observation が `DesiredSnapshot` を書き換える
ことはあってはならない。

#### 11. External ownership invariant

外部 source object は deployment destroy で破壊されない。link が所有する生成
grant、credential、endpoint、projection は revoke または削除される。revoke 失敗
は `RevokeDebt` を作る。

#### 12. Concurrency invariant

production インストールは GroupHead 更新、activation 更新、ingress 予約、生成
credential 変更、生成 grant 変更、namespace registry 書込み、Space export
共有、catalog release activation を直列化しなければならない。

#### 13. Space containment invariant

すべての Deployment、ResolutionSnapshot、DesiredSnapshot、OperationJournal、
ObservationSet、RevokeDebt、ActivationSnapshot、approval、GroupHead は厳密に 1
つの Space に属する。deployment は自身の Space の外で resolve、materialize、
activate、observe、destroy してはならない。Space export 共有や operator 承認の
escape hatch によってのみ例外が許される。

#### 14. Namespace isolation invariant

namespace path は Space scope である。default では 2 つの Space の同じ path
は同じ ExportDeclaration ではない。`takos` のような予約 prefix は operator
管理だが、可視性は依然として Space scope である。

#### 15. Space data-boundary invariant

secret、DataAsset、operation journal、observation、approval、audit event は
Space scope である。これらを Space を跨いで共有するには明示的な operator policy
が必要で、ResolutionSnapshot に記録されなければならない。

### 最終 root primitive {#最終-root-primitive}

```text
Manifest
Space
IntentGraph
CatalogRelease
ResolutionSnapshot
DesiredSnapshot
Object
ExportDeclaration
ExportMaterial
Link
ProjectionSelection
Exposure
DataAsset
OperationPlan
WriteAheadOperationJournal
ObservationSet
DriftIndex
RevokeDebt
ActivationSnapshot
GroupHead
```

`ProjectionSelection` は `Link` の属性である。public な authoring object では
ない。
