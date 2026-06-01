# バックアップとリストア {#backup-and-restore}

operator-managed deployment 向けの reference backup / restore profile。Takosumi core の portability surface は Installation / Deployment、source identity、`planSnapshotDigest`、binding snapshot、non-secret outputs、Deployment の記録の可用性で説明します。このページは current reference operator がその surface を復元するために保存する logical record set、backup フォーマット、point-in-time 整合性 invariant、audit chain 整合性を保つ順序付き restore 手順を説明します。

protocol は logical record stream を扱う。snapshot は Takosumi の storage 抽象から取得する。operator は冗長性のために SQL / object store / filesystem level の物理 backup を下に重ねてよいが、Takosumi 適合な restore はここで定義する logical path を通る。

## Backup のスコープ {#backup-scope}

reference storage record は 2 クラスに分割される: reference operator が復元に必要とする critical record と、 restore 後に再構成する **regenerable** な record。compatible operator は同じ table / record names を使う必要はありません。

### Critical (backup 必須) {#critical-backup-required}

| Record                         | Why critical                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `ResolvedPlan`                 | Immutable plan input; required to replay the WAL.                                |
| `TargetState`                  | Operator-authored intent; cannot be reconstructed from runtime state.            |
| `TrafficSnapshot`              | Records which Resolution is currently active per Space.                          |
| `OperationJournal` (WAL)       | Idempotency tuples and effect digests; without this, replay diverges.            |
| `CleanupBacklog`               | Outstanding rollback obligations; loss leaks effects.                            |
| `Approval`                     | Bound `approvedEffects` for in-flight and historical operations.                 |
| `AuditLog`                     | Hash-chained event log; loss breaks chain verification.                          |
| Secret partition (encrypted)   | Operator-managed master-key-encrypted secret material.                           |
| Operator implementation config | Which PlatformServices / implementation bindings / connector inventory were visible. |
| `assetRecord` metadata         | Optional asset extension metadata needed for retention / replay.                 |

これらが集合として current reference profile の **backup set** を構成する。別 operator distribution は、同等の Installation / Deployment restore semantics を満たす別の storage layout と backup set を定義できます。

operator が asset extension を mount する場合、logical backup は `assetRecord` metadata を含む。object store bytes は同じ backup point に対応する physical backup または content-addressed export で保全する。

### Regenerable records {#regenerable-backup-not-required}

| Record                                 | How regenerated                                                            |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `ObservationState` (current state)     | Recomputed by the next observe phase against runtime-agent describe.       |
| `DriftIndex`                           | Recomputed from `ObservationState` and the active `ResolvedPlan`.          |
| `PlatformServiceMaterialization` cache | Re-derived from `ResolvedPlan` and managed objects.                        |
| Generated object cache                 | Re-rendered from link projection rules and source output material.         |
| `ObservationHistory` (opt-in)          | Operator-configurable; treated as regenerable unless the operator pins it. |

operator は restore 後の warm-up を速めるために regenerable record を backup に含めて **もよい** が、適合な restore はそれらが無くても成功しなければならない。

## Backup フォーマット {#backup-format}

logical export は Takosumi 内部 JSON の単一 multi-record stream として生成される。各 record は次を含む。

- `spaceId` — 対象 Space ID。Space を跨ぐ record (audit chain global、operator implementation config evidence) は予約値 `space:_global` を使う。
- `id` — [Resource IDs](./resource-ids.md) に従う resource ID。
- `kind` — record の kind (例: `resolution-snapshot`、`journal-entry`)。
- `body` — record の中身。
- `chainRef` — audit chain に乗る record は、直前の chained record を指す hash chain reference。

stream は人間可読な JSON で、1 行 1 record。 `chainRef` が常に stream 内で既出の record を後方参照するよう順序付けされる。 restore は stream を順次読み、chain を進みながら検証する。

フォーマットは Takosumi major version 内で安定。public restore flow は cross-major restore を reject する。cross-major recovery が必要な場合は release-specific / private recovery tooling で same-major export を作ってから、この restore contract に渡す。

> Rationale: format を major に bind することで restore path は logical import のみで完結し、restore tool に migration logic を埋め込まずに済む。schema 互換層を restore と migration の両方に二重実装する保守コストを避け、cross-major recovery は release-specific private runbook で扱う設計にしている。

## Backup の不変条件 {#backup-invariant}

backup は 3 つの invariant を満たさなければならない。 operator backup ツールは構造的にこれらを満たすこと。

### Point-in-time 整合性 {#point-in-time-integrity}

backup はすべての Space と critical record store に対する backup mode lock を取得する。 lock 下で:

- すべての critical record は単一の point-in-time snapshot として export される。
- in-flight operation は、lock 取得前に WAL terminal stage まで完了するか pause される (WAL cursor は backup 内の最新 cursor として含まれる)。
- lock の継続時間中、新規の deploy / approve / observe 書き込みは `failed_precondition` かつ `retryable: true` で reject される。

backup duration は per-Space lock TTL で範囲が決まる。 operator が TTL を調整する。 default は現実の backup window が単一 TTL に収まるよう保守的に設定してある。

### Secret partition の non-re-encryption {#secret-partition-non-re-encryption}

secret partition record は **そのまま** 、 operator の master key で暗号化されたままで export される。 backup ツールは secret material を復号して再暗号化しない。帰結は 2 つ。

- export stream が漏洩しても、master key なしには backup は使えない。
- restore には operator が同じ master key (または同じ partition key を派生ツリー内に持つ master key) を供給する必要がある。 master key が一致しないと secret partition の読み込みステップで restore が失敗する。

### Space 横断の順序保存 {#cross-space-order-preservation}

audit chain は per-Space ではなく global に rotate する。 backup は global chain の順序を保つ: 異なる Space の record が同じ chain segment を共有するとき、 export stream 内での相対的な emission 順序は chain hash linkage と一致する。 restore は ingest 中に global chain を検証する。順序外の ingest は早期失敗する。

## Restore のフロー {#restore-flow}

restore は 6 ステップの sequence。各ステップは hard gate であり、前のステップが検証されるまで次のステップは始められない。

### 1. ストレージの初期化 {#1-storage-initialization}

ターゲット storage は空、または backup を生成した Takosumi と同じ schema version で初期化されている。operator は restore 前に schema version を確認する。 cross-major restore はこのステップで reject される。target は backup 生成元と同じ Takosumi major / schema range に属していなければならない。

### 2. Secret master key の注入 {#2-secret-master-key-injection}

operator は record ingest の前に master key (または master key 派生材料) を供給する。鍵は operator の secret backend が保持し、restore ツールは Takosumi が runtime で使うのと同じ factory 経由で読み込む。

### 3. Logical import {#3-logical-import}

restore ツールは export stream を依存順にトランザクションで ingest する。

1. operator implementation config evidence。
2. `Approval` record。
3. `TargetState` record。
4. `ResolvedPlan` record。
5. `TrafficSnapshot` record。
6. `OperationJournal` (WAL) entry、per-Space WAL cursor 順。
7. `CleanupBacklog` record。
8. `assetRecord` metadata。
9. `AuditLog` entry。
10. secret partition entry (暗号化 blob)。

各 record の identity と内容は ingest 時に encode 済みの形と照合される。 identity 衝突は restore を abort する。

### 4. Audit chain の検証 {#4-audit-chain-verification}

`AuditLog` の ingest が終わったら、restore ツールは chain を genesis から walk して各 hash link を検証する。 chain が壊れていれば、何の record も commit せずに restore が abort される (失敗時にステップ 3 のトランザクションは rollback される)。

### 5. Lock store の再構築 {#5-lock-store-reconstruction}

WAL に記録された in-flight operation を reconcile する。 terminal stage に達していない各 operation について:

- `commit` cursor と effect digest が存在する場合、operation は completable と mark され、 apply pipeline は restore 後の最初の tick で `recoveryMode = continue` を使って完了する。
- `commit` cursor が無い場合、operation は resource side effect 未到達として terminal `abort` へ進める。compensate operation は呼ばない。

cross-process lock store は in-flight operation の metadata から再構築される。再構築が完了するまで新規 operation は dispatch されない。

### 6. TrafficSnapshot の再評価 {#6-activationsnapshot-reevaluation}

backup の activation state は authoritative な intent として復元されるが、 object ごとの health (`observe` 出力) は backup から復元 **されない** (これは regenerable)。 restore 後の最初の observe tick が runtime-agent describe から `ObservationState` と `DriftIndex` を再構築する。

最初の observe tick が完了するまで、復元された object の `LifecycleStatus` は `unknown` として報告される。 operator は復元する object 数に比例した warm-up window を見込むべき。

## Restore 後の挙動 {#post-restore-behavior}

### TargetState の immutability {#desiredsnapshot-immutability}

`TargetState` record は restore 上で immutable。 backup 時点でまだ snapshot 化されていなかった desired state 変更は保存されない。 operator は再 authoring し再 deploy する。

### In-flight operation の解決 {#in-flight-operation-resolution}

in-flight operation はステップ 5 で記録された recovery mode を通じて resume する。各 Implementation が `recoveryMode = continue` と `recoveryMode = compensate` をどう扱うかは [Kind Binding Implementations](./kind-bindings.md) が定める。

### RoutingPointer と canary の状態 {#grouphead-and-canary-state}

`RoutingPointer` pointer と canary / shadow rollout state は `TrafficSnapshot` の一部で、 backup 時点の通りに復元される。 30% で rollout 中だった canary は restore 後も 30% 状態のままで、 rollout state machine は次の deploy でその点から続行する。

## Restore の境界 {#restore-boundary}

restore は **同じ Takosumi major version 内で保証される**。cross-major restore は release-specific private runbook と検証済みの記録を要求する。restore ツールは直接 restore を止め、closed な `failed_precondition` エラーレスポンスを発行する。

## オペレーター surface {#operator-surface}

現行の public `takosumi` CLI は backup / restore コマンドを公開していない。 backup と restore は operator 限定の workflow であり、 public operator CLI surface が実装され [CLI](./cli.md) で文書化されるまでは、内部 control plane ツールや deployment 自動化を通じて駆動する必要がある。

- backup は上述の point-in-time lock 下で export stream を生成する。
- restore は上記 6 ステップのフローを、初期化された空 storage に対して実行する。

両コマンドとも Installer bearer や asset writer token ではなく operator bearer 認証を要求する。両コマンドとも下記 audit event を通じて進捗を記録する。

## 監査イベント {#audit-event}

backup と restore は runtime Takosumi event と同じ hash chain に専用 audit event を発行する。

| Event               | Emitted at                                                      |
| ------------------- | --------------------------------------------------------------- |
| `backup-started`    | Lock acquired, before record export begins.                     |
| `backup-completed`  | Final record written and lock released.                         |
| `restore-started`   | Storage initialized and master key accepted.                    |
| `restore-completed` | Step 6 finished and the kernel transitions to normal operation. |

各 event は payload に backup export 時点の `backupChainHead` を運ぶ。restore を backup に対して検証することは、 `restore-completed` payload の `backupChainHead` が `backup-completed` payload の `backupChainHead` と一致することの確認に等しい。restore event 自体を同じ audit chain に append する場合、 restore 後の current chain head は当然別の値になる。

## 関連アーキテクチャノート

- [Snapshot Model](./architecture/snapshot-model.md)
- [Runtime Deployment — Operation Plan & WAL](./architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal)
- [Drift Detection](./drift-detection.md)
- [Operational Hardening Checklist](./architecture/operational-hardening-checklist.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)

## 関連ページ

- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [Secret Partitions](./secret-partitions.md)
- [Schema Evolution](./migration-upgrade.md)
- [CLI](./cli.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Enum and Value Index](./closed-enums.md)
