# Runtime Deployment モデル {#runtime-deployment-model}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。Takosumi の public concept は
`Source` / `Installation` / `Deployment` / `PlatformService` に閉じる。このページの `ResolvedPlan`、`TargetState`、
`PlatformServiceDeclaration`、`PlatformServiceMaterialization`、OperationPlan、journal、生成 object は reference implementation
内部の runtime primitive / evidence object であり、Source authoring vocabulary ではない。provider infrastructure の
materialization workflow は operator distribution が所有し、Takosumi は PlatformService inventory を consume して
Deployment の binding snapshot / evidence として記録する。
:::

## Operation Plan と Write-Ahead Journal {#operation-plan--write-ahead-journal}

OperationPlan は 1 つの Space 内で derived される work である。 WriteAheadOperationJournal は実行の authority である。

### OperationPlan {#operationplan}

OperationPlan は同じ Space の `TargetState` と `ObservationState` から derive される。

含まれる operation の例:

```text
apply-object
delete-object
verify-object
record-link-binding
refresh-link-binding
revoke-link
prepare-exposure
activate-exposure
resolve-data-asset-extension
observe
compensate
```

OperationPlan は execution plan です。canonical desired state は TargetState が持ちます。

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
cleanup-backlog-created when needed
```

### Stage 列挙 {#stage-enumeration}

各 journal entry は closed v1 enum から `stage` を持つ。stage は成功 operation では以下の順序で進む。`abort` と `skip` は forward stage を置き換えうる終端 stage である。

```text
prepare      → pre-commit → commit → post-commit → observe → finalize
                                       \
                                        → abort     (no further stages)
                                        → skip      (no-op resolution)
```

| stage       | may request operator-owned provider effects | may queue CleanupBacklog | may re-validate approval |
| ----------- | ------------------------------------------- | ------------------------ | ------------------------ |
| prepare     | no                                          | no                       | yes                      |
| pre-commit  | no                                          | no                       | yes                      |
| commit      | yes                                         | no                       | no                       |
| post-commit | no                                          | yes                      | no                       |
| observe     | no                                          | yes                      | no                       |
| finalize    | no                                          | no                       | no                       |
| abort       | no                                          | yes                      | no                       |
| skip        | no                                          | no                       | no                       |

`pre-commit` は operator asset extension policy gate ([Operator asset Extension Policy](../data-asset-policy.md) 参照) と [バインディングモデル](./binding-model.md) が上げる衝突 risk の canonical な enforcement point である。source build / preparation は Installer API submission 前の build-service / CI policy で扱う。`commit` は operator-owned provider workflow に resource side effect を request しうる唯一の stage である。`post-commit` は commit 後の evidence / projection を記録し、外部 cleanup が完了できないとき debt を queue する。新規 stage は RFC (CONVENTIONS.md §6) を要する。

### 冪等性キー {#idempotency-keys}

各 journal entry は決定的な idempotency key を持つ。

```text
idempotencyKey = (spaceId, operationPlanDigest, journalEntryId)
```

この 3 つ組は Space の WAL 内で一意である。replay 時、同じ 3 つ組は決定的に同じ operation を再適用する。同じ `(spaceId, operationPlanDigest, journalEntryId)` で来た replay の effect digest が以前に記録された entry と一致しない場合、Takosumi は operation を hard-fail させ stage を進めない。その場合の recovery は新しい `operationPlanDigest` (新規 OperationPlan) を発行しなければならない。

### Pre/post-commit の verification {#prepost-commit-verification}

implementation binding と PlatformService inventory は operator が与える resolution 入力である。 Takosumi は reference-internal
`ResolvedPlan` に記録した selection を pre-commit と post-commit で再検証し、Deployment の `bindingsSnapshot` / evidence に
記録する。selected binding が宣言する実行可能 hook package や provider infrastructure workflow を実行する主体は operator
distribution です。kind の定義は kind identity / input schema / output slot などの semantic metadata に閉じます。
Verification lifecycle:

```text
1. discovery        — Space-visible operator-owned PlatformService inventory and implementations
2. selection check  — recorded service selections / selected implementations /
                      connector visibility are revalidated
3. result recorded  — verification outcome is journaled as evidence
4. fail-closed      — pre-commit failure aborts before resource effects;
                      post-commit failure records CleanupBacklog and continues
                      observe/finalize evidence
```

Verification は policy または approval 再検証を bypass してはならない。 CleanupBacklog は `post-commit` / `observe` / `finalize` / `abort` stage から発行できる。`commit` 前に actual effect が無い entry は CleanupBacklog ではなく abort evidence として終端する。

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

reference-internal 生成 object / evidence record の id は外部呼び出しの前に計算されるべきである。

```text
authorization id = hash(spaceId, deploymentId, linkId, platformServiceSnapshotId, accessMode)
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

OperationPlan、OperationJournal、reference-internal 生成 object id、compensation record、 CleanupBacklog は厳密に 1 つの Space に属する。ある Space の journal entry を別 Space の recovery authority として使ってはならない。

Space-global な state を変更する critical operation は Space 単位で直列化され、 global ingress 予約は operator-level の追加直列化を要しうる。

### OperationJournal の保持 {#operationjournal-retention}

OperationJournal は side-effect と recovery の履歴を保持する。アクティブな reference-internal 生成 object / evidence、未解決の compensation、未解決の revoke debt、現在の activation に関連する entry は compaction で消してはならない。

別 store が保持しうるもの:

```text
AuditLog
ObservationHistory
CurrentStateIndex
```

## Invariant-First Root モデル {#invariant-first-root-model}

### 必須 invariant {#invariants}

#### Snapshot / Authority

**1. Authority invariant** --- Apply、activate、rollback、destroy は記録された `ResolvedPlan` と `TargetState` を使う。resource effects の直前に catalog documents や platform service registry を再解決して authority を差し替えてはならない。

**2. Snapshot invariant** --- `ResolvedPlan` と `TargetState` は immutable である。新しい意味または desired graph は新しい snapshot を作る。

**3. Identity invariant** --- すべての reference-internal `Object`、`PlatformServiceDeclaration`、`PlatformServiceMaterialization`、`Link`、`Exposure`、 `Operation`、operator asset extension record、generated object、activation item は安定したアドレスを持つ。これらは public concept ではなく、public surface は `Source` / `Installation` / `Deployment` / `PlatformService` と Deployment の snapshot / evidence に閉じる。

#### Ownership / Security

**4. Ownership invariant** --- reference runtime object / evidence の lifecycle class は operation を制限する。provider infrastructure と materialization workflow の所有者は operator distribution であり、Takosumi は binding snapshot / evidence を記録する。

```text
managed:
  may be created, updated, replaced, deleted by the deployment

generated:
  owned by an Object, Link, Exposure, optional asset extension, or Operation
  must have owner, reason, deterministic id, and delete policy

external:
  may be verified, observed, linked, and authorized
  must not be created or deleted by the deployment

operator:
  controlled by operator policy
  user deployment must not delete it

imported:
  pre-existing object registered by operator policy
  delete is denied unless explicitly operator-approved
```

この invariant を強制する revoke flow は [Object Model — Object revoke flow](./object-model.md) に詳しい。

**5. Secret invariant** --- raw secret 値は Takosumi canonical state に保存されない。Takosumi state には secret reference、handle、projection metadata、audit event を保存できる。

**11. External ownership invariant** --- 外部 source object は deployment destroy で破壊されない。link が所有する生成 authorization、credential、endpoint、projection は revoke または削除される。 revoke 失敗は `CleanupBacklog` を作る。

#### Execution / Journal

**6. Effects invariant** --- implementation は `approvedEffects` を超えてはならない。超えた場合は実行を一時停止し、overflow を journal し、可能なら compensation を実行し、承認を要求するか fail する。

**7. Write-ahead journal invariant** --- side-effect を持つ operation は side effect の前に intent を記録する。reference-internal 生成 object identity は外部呼び出しの前に計画する。観測された handle は外部呼び出しの後に append する。

**8. Idempotency invariant** --- retry は同じ intent である。reference-internal 生成 object identity は、deployment id、link id、service snapshot id、access mode、exposure id、desired generation のような安定した入力から決定的に決まるべきである。

#### Activation / Observation

**9. Activation invariant** --- Installer API の public install / deploy の内側では apply phase と activation phase を分けて扱う。RoutingPointer と traffic assignment は apply phase の再検証後にのみ移動する。

**10. Observation invariant** --- Observation は reality を記録する。`TargetState` を書き換えてはならない。

#### Concurrency

**12. Concurrency invariant** --- production インストールは以下を直列化する:

- RoutingPointer 更新、activation 更新
- ingress 予約
- reference-internal 生成 credential / authorization 変更
- operator-owned PlatformService inventory / binding registry 書込み
- future cross-Space service sharing policy
- descriptor / implementation binding set 更新

#### Space 境界

**13. Space containment invariant** --- すべての Deployment、reference-internal ResolvedPlan、TargetState、OperationJournal、 ObservationState、CleanupBacklog、TrafficSnapshot、approval、RoutingPointer は厳密に 1 つの Space に属する。deployment は自身の Space の外で resolve、record binding evidence、activate、observe、destroy してはならない。provider infrastructure の materialization は operator distribution の Space / account policy に従う。current v1 には Space 越えの service input はなく、将来 RFC が定義する明示的な sharing model なしに例外は許されない。

**14. Platform service isolation invariant** --- platform service path と publication discovery は Space scope である。外部 source は、Space に可視化された `PlatformService` inventory entry の exact match、または Space-visible publication の `kind` / labels selection でのみ解決できる。reference-internal `PlatformServiceDeclaration` / `PlatformServiceMaterialization` はその resolution evidence であり、public authoring object ではない。2 つの Space の同じ path や同じ provider material は current v1 では同一 material として扱わない。

**15. Space data-boundary invariant** --- secret、operator asset extension record、operation journal、observation、 approval、audit event は Space scope である。Space を跨ぐ共有には明示的な operator policy が必要で、ResolvedPlan に記録する。

### Reference implementation internal primitives {#reference-implementation-internal-primitives}

以下は reference implementation の内部 runtime primitive / evidence object であり、public concept や Source authoring vocabulary ではない。`PlatformServiceDeclaration` は Space-visible PlatformService inventory から解決した declaration evidence、`PlatformServiceMaterialization` は operator-owned provider workflow の結果として記録する materialization evidence を指す。

```text
SourcePayload
Space
IntentGraph
ResolvedPlan
TargetState
Object
PlatformServiceDeclaration
PlatformServiceMaterialization
Link
ProjectionSelection
Exposure
OperationPlan
WriteAheadOperationJournal
ObservationState
DriftIndex
CleanupBacklog
TrafficSnapshot
RoutingPointer
```

`ProjectionSelection` は `Link` の属性である。public な authoring object ではない。
