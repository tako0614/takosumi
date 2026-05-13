# Invariant-first Root Model

> このページでわかること: invariant-first root モデルの設計原則。

Takosumi v1 は単に graph-shaped であるだけでなく、**invariant-first** である。
graph は形を与え、invariant が operation を安全に保つ。

## North star

```text
Takosumi v1 is an invariant-first, space-isolated, snapshot-backed,
graph-shaped, write-ahead-operation-journaled PaaS operation kernel.
```

manifest は authoring 入力である。deployment は Space の中で resolve される。
deployment は immutable な snapshot 群、operation journal、observation の
集合である。

## Root pipeline

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

## 必須 invariant

### 1. Authority invariant

Apply、activate、rollback、destroy は記録された `ResolutionSnapshot` と
`DesiredSnapshot` を使わなければならない。live descriptor URL、live namespace
registry、再計算した semantics を authority として使ってはならない。

### 2. Snapshot invariant

`ResolutionSnapshot` と `DesiredSnapshot` は immutable である。新しい意味または
desired graph は新しい snapshot を作る。

### 3. Identity invariant

すべての `Object`、`ExportDeclaration`、`Link`、`Exposure`、`DataAsset`、
`Operation`、generated object、activation item は安定したアドレスを持つ。

### 4. Ownership invariant

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

### 5. Secret invariant

raw secret 値は core canonical state に保存されない。core state には secret
reference、handle、projection metadata、audit event を保存できる。

### 6. Effects invariant

implementation は `approvedEffects` を超えてはならない。`actualEffects` が
approved effect を超えた場合、実行は一時停止し、overflow を journal し、可能なら
compensation を実行し、承認を要求するか fail しなければならない。

### 7. Write-ahead journal invariant

side-effect を持つ operation は side effect の前に intent を記録しなければなら
ない。生成 object identity は外部呼び出しの前に計画されなければならない。観測
された handle は外部呼び出しの後に append されなければならない。

### 8. Idempotency invariant

retry は同じ intent である。生成 object identity は、deployment id、link id、
export snapshot id、access mode、exposure id、desired generation のような安定
した入力から決定的に決まるべきである。

### 9. Activation invariant

Apply と activation は分離されている。GroupHead と traffic assignment は apply
phase の再検証後にのみ移動する。

### 10. Observation invariant

Observation は reality を記録する。Observation が `DesiredSnapshot` を書き換える
ことはあってはならない。

### 11. External ownership invariant

外部 source object は deployment destroy で破壊されない。link が所有する生成
grant、credential、endpoint、projection は revoke または削除される。revoke 失敗
は `RevokeDebt` を作る。

### 12. Concurrency invariant

production インストールは GroupHead 更新、activation 更新、ingress 予約、生成
credential 変更、生成 grant 変更、namespace registry 書込み、Space export
共有、catalog release activation を直列化しなければならない。

### 13. Space containment invariant

すべての Deployment、ResolutionSnapshot、DesiredSnapshot、OperationJournal、
ObservationSet、RevokeDebt、ActivationSnapshot、approval、GroupHead は厳密に 1
つの Space に属する。deployment は自身の Space の外で resolve、materialize、
activate、observe、destroy してはならない。Space export 共有や operator 承認の
escape hatch によってのみ例外が許される。

### 14. Namespace isolation invariant

namespace path は Space scope である。default では 2 つの Space の同じ path
は同じ ExportDeclaration ではない。`takos` のような予約 prefix は operator
管理だが、可視性は依然として Space scope である。

### 15. Space data-boundary invariant

secret、DataAsset、operation journal、observation、approval、audit event は
Space scope である。これらを Space を跨いで共有するには明示的な operator policy
が必要で、ResolutionSnapshot に記録されなければならない。

## 最終 root primitive

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
