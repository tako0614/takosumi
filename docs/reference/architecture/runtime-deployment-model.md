# Runtime Deployment モデル {#runtime-deployment-model}

This page describes reference implementation internals. The portable public
contract is AppSpec / Installation / Deployment and the Installer API; the
objects below are execution state used by an implementation or operator
distribution.

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
resolve-data-asset-extension
observe
compensate
```

OperationPlan は execution plan です。canonical desired state は DesiredSnapshot
が持ちます。

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

| stage       | may write provider actual-effects | may queue RevokeDebt | may re-validate approval |
| ----------- | --------------------------------- | -------------------- | ------------------------ |
| prepare     | no                                | no                   | yes                      |
| pre-commit  | no                                | no                   | yes                      |
| commit      | yes                               | no                   | no                       |
| post-commit | no                                | yes                  | no                       |
| observe     | no                                | yes                  | no                       |
| finalize    | no                                | no                   | no                       |
| abort       | no                                | yes                  | no                       |
| skip        | no                                | no                   | no                       |

`pre-commit` は operator DataAsset extension policy gate
([Operator DataAsset Extension Policy](../data-asset-policy.md) 参照) と
[Link and Projection Model](./link-projection-model.md) が上げる衝突 risk の
canonical な enforcement point である。source build / preparation は Installer
API submission 前の build-service / CI policy で扱う。`commit` は provider side
effect を実行しうる唯一の stage である。`post-commit` は commit 後の evidence /
projection を記録し、外部 cleanup が完了できないとき debt を queue する。新規
stage は RFC (CONVENTIONS.md §6) を要する。

### 冪等性キー {#idempotency-keys}

各 journal entry は決定的な idempotency key を持つ。

```text
idempotencyKey = (spaceId, operationPlanDigest, journalEntryId)
```

この 3 つ組は Space の WAL 内で一意である。replay 時、同じ 3 つ組は決定的に同じ
operation を再適用する。同じ `(spaceId, operationPlanDigest, journalEntryId)`
で来た replay の effect digest が以前に記録された entry と一致しない場合、kernel
は operation を hard-fail させ stage を進めない。その場合の recovery は新しい
`operationPlanDigest` (新規 OperationPlan) を発行しなければならない。

### Pre/post-commit の verification {#prepost-commit-verification}

kind alias と implementation binding は operator が与える resolution
入力である。 kernel は `ResolutionSnapshot` に記録した selection を pre-commit
と post-commit で再検証する。selected implementation binding が宣言する実行可能
hook package を実行する主体は operator implementation binding です。descriptor
は kind identity / input schema / publish-listen / outputs などの semantic
metadata に閉じます。Verification lifecycle:

```text
1. discovery        — Space-visible kind aliases and implementations
2. selection check  — recorded kind aliases / selected implementations /
                      connector visibility are revalidated
3. result recorded  — verification outcome is journaled as evidence
4. fail-closed      — pre-commit failure aborts before provider effects;
                      post-commit failure records RevokeDebt and continues
                      observe/finalize evidence
```

Verification は policy または approval 再検証を bypass してはならない。
RevokeDebt は `post-commit` / `observe` / `finalize` / `abort` stage から発行
できる。`commit` 前に actual effect が無い entry は RevokeDebt ではなく abort
evidence として終端する。

### Journal エントリ {#journal-entries}

```yaml
JournalEntry:
  spaceId: space_acme_prod
  journalId: journal:...
  operationId: operation:...
  deploymentId: dep_...
  desiredSnapshotId: desired:...
  operationPlanDigest: sha256:...
  stage: prepare
  idempotencyKey: ...
  desiredGeneration: 7
  approvedEffects: {}
  timestamp: ...
```

### 決定的な生成 id {#deterministic-generated-ids}

生成 object の id は外部呼び出しの前に計算されるべきである。

```text
grant id = hash(spaceId, deploymentId, linkId, publicationSnapshotId, accessMode)
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

OperationJournal は side-effect と recovery の履歴を保持する。アクティブな生成
object、未解決の compensation、未解決の revoke debt、現在の activation に
関連する entry は compaction で消してはならない。

別 store が保持しうるもの:

```text
AuditLog
ObservationHistory
CurrentStateIndex
```

## Invariant-First Root モデル {#invariant-first-root-model}

### 必須 invariant {#invariants}

#### 1. Authority invariant

Apply、activate、rollback、destroy は記録された `ResolutionSnapshot` と
`DesiredSnapshot` を使わなければならない。provider effects の直前に catalog
documents や external publication registry を再解決して authority を差し替えて
はならない。

#### 2. Snapshot invariant

`ResolutionSnapshot` と `DesiredSnapshot` は immutable である。新しい意味または
desired graph は新しい snapshot を作る。

#### 3. Identity invariant

すべての
`Object`、`ExternalPublicationDeclaration`、`Link`、`Exposure`、`Operation`、
operator DataAsset extension record、generated object、activation item
は安定したアドレスを持つ。

#### 4. Ownership invariant

lifecycle class は operation を制限する。

```text
managed:
  may be created, updated, replaced, deleted by the deployment

generated:
  owned by an Object, Link, Exposure, optional DataAsset extension, or Operation
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
publication snapshot id、access mode、exposure id、desired generation
のような安定 した入力から決定的に決まるべきである。

#### 9. Activation invariant

Installer API の public install / deploy の内側では apply phase と activation
phase を分けて扱う。GroupHead と traffic assignment は apply phase の再検証後
にのみ移動する。

#### 10. Observation invariant

Observation は reality を記録する。Observation が `DesiredSnapshot` を書き換える
ことはあってはならない。

#### 11. External ownership invariant

外部 source object は deployment destroy で破壊されない。link が所有する生成
grant、credential、endpoint、projection は revoke または削除される。revoke 失敗
は `RevokeDebt` を作る。

#### 12. Concurrency invariant

production インストールは GroupHead 更新、activation 更新、ingress 予約、生成
credential 変更、生成 grant 変更、external publication registry 書込み、Space
publication 共有、kind alias / descriptor / implementation binding set
更新を直列化しなければならない。

#### 13. Space containment invariant

すべての Deployment、ResolutionSnapshot、DesiredSnapshot、OperationJournal、
ObservationSet、RevokeDebt、ActivationSnapshot、approval、GroupHead は厳密に 1
つの Space に属する。deployment は自身の Space の外で resolve、materialize、
activate、observe、destroy してはならない。Space publication 共有や operator
承認の escape hatch によってのみ例外が許される。

#### 14. External publication isolation invariant

external publication path は Space scope である。current public v1 で external
publication path として解決できる外部 source は、Space に可視化された external
publication declaration の exact match である。2 つの Space の同じ path
は、共有された ExternalPublicationDeclaration snapshot に解決された場合だけ同一
material として扱う。

#### 15. Space data-boundary invariant

secret、operator DataAsset extension record、operation journal、observation、
approval、audit event は Space scope である。これらを Space を跨いで共有する
には明示的な operator policy が必要で、ResolutionSnapshot に記録されなければ
ならない。

### Reference implementation internal primitives {#reference-implementation-internal-primitives}

```text
AppSpec
Space
IntentGraph
ResolutionSnapshot
DesiredSnapshot
Object
ExternalPublicationDeclaration
PublicationMaterialization
Link
ProjectionSelection
Exposure
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
