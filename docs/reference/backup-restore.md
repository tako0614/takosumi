# バックアップとリストア {#backup-and-restore}

> このページでわかること: kernel state のバックアップとリストアの手順。

operator self-host deployment 向け Takosumi v1 backup / restore プロトコル。
backup 必須の storage record、regenerable で skip 可能な record、on-disk な
backup フォーマット、point-in-time 整合性 invariant、audit chain
整合性を保つ順序付き restore 手順を定義する。

protocol は logical であり physical ではない。 snapshot は kernel の storage
抽象から取得され、 基底の SQL / object store / filesystem layout からではない。
operator は冗長性のために物理 backup を下に重ねてよいが、 Takosumi 適合な
restore は常にここで定義する logical path を通る。

## Backup のスコープ {#backup-scope}

storage record は 2 クラスに分割される: kernel を回復するために **backup 必須**
な critical record と、 restore 後に kernel が再構成する **regenerable** な
record。

### Critical (backup 必須) {#critical-backup-required}

| Record                       | Why critical                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `ResolutionSnapshot`         | Immutable plan input; required to replay the WAL.                     |
| `DesiredSnapshot`            | Operator-authored intent; cannot be reconstructed from runtime state. |
| `ActivationSnapshot`         | Records which Resolution is currently active per Space.               |
| `OperationJournal` (WAL)     | Idempotency tuples and effect digests; without this, replay diverges. |
| `RevokeDebt`                 | Outstanding rollback obligations; loss leaks effects.                 |
| `Approval`                   | Bound `approvedEffects` for in-flight and historical operations.      |
| `AuditLog`                   | Hash-chained event log; loss breaks chain verification.               |
| Secret partition (encrypted) | Operator-managed master-key-encrypted secret material.                |
| Catalog adoption record      | Which catalog releases the operator has installed and trusts.         |

これらが集合として v1 の **backup set** を構成する。 いずれかの行を省略する v1
backup は非適合。 reserved な将来の record は、対応する RFC
が受理されたときにのみ必須となる。

### Regenerable (backup 不要) {#regenerable-backup-not-required}

| Record                           | How regenerated                                                            |
| -------------------------------- | -------------------------------------------------------------------------- |
| `ObservationSet` (current state) | Recomputed by the next observe phase against runtime-agent describe.       |
| `DriftIndex`                     | Recomputed from `ObservationSet` and the active `ResolutionSnapshot`.      |
| `ExportMaterial` cache           | Re-derived from `ResolutionSnapshot` and managed objects.                  |
| Generated object cache           | Re-rendered from link projection rules and source exports.                 |
| `ObservationHistory` (opt-in)    | Operator-configurable; treated as regenerable unless the operator pins it. |

operator は restore 後の warm-up を速めるために regenerable record を backup
に含めて **もよい** が、 適合な restore
はそれらが無くても成功しなければならない。

## Backup フォーマット {#backup-format}

logical export は kernel 内部 JSON の単一 multi-record stream として生成される。
各 record は次を含む。

- `spaceId` — 所有 Space ID。 Space を跨ぐ record (audit chain global、catalog
  adoption) は予約値 `space:_global` を使う。
- `id` — [Resource IDs](./resource-ids.md) に従う resource ID。
- `kind` — record の kind (例: `resolution-snapshot`、`journal-entry`)。
- `body` — record の中身。
- `chainRef` — audit chain に乗る record は、直前の chained record を指す hash
  chain reference。

stream は人間可読な JSON で、1 行 1 record。 `chainRef` が常に stream 内で既出の
record を後方参照するよう順序付けされる。 restore は stream を順次読み、chain
を進みながら検証する。

フォーマットは kernel major version 内で安定。public restore flow は cross-major
restore を reject する。cross-major recovery が必要な場合は release-specific /
private recovery tooling で same-major export を作ってから、この restore
contract に渡す。

> Rationale: format を major に bind することで restore path は logical import
> のみで完結し、restore tool に migration logic を埋め込まずに済む。schema
> 互換層を restore と migration
> の両方に二重実装する保守コストを避け、cross-major recovery は明示的に public
> restore contract の外側に置く設計にしている。

## Backup の不変条件 {#backup-invariant}

backup は 3 つの invariant を満たさなければならない。 operator backup
ツールは構造的にこれらを満たすこと。

### Point-in-time 整合性 {#point-in-time-integrity}

backup はすべての Space と critical record store に対する backup mode lock
を取得する。 lock 下で:

- すべての critical record は単一の point-in-time snapshot として export
  される。
- in-flight operation は、lock 取得前に WAL terminal stage まで完了するか pause
  される (WAL cursor は backup 内の最新 cursor として含まれる)。
- lock の継続時間中、新規の deploy / approve / observe 書き込みは
  `failed_precondition` かつ `retryable: true` で reject される。

backup duration は per-Space lock TTL で範囲が決まる。 operator が TTL
を調整する。 default は現実の backup window が単一 TTL
に収まるよう保守的に設定してある。

### Secret partition の non-re-encryption {#secret-partition-non-re-encryption}

secret partition record は **そのまま** 、 operator の master key
で暗号化されたままで export される。 backup ツールは secret material
を復号して再暗号化しない。 帰結は 2 つ。

- export stream が漏洩しても、master key なしには backup は使えない。
- restore には operator が同じ master key (または同じ partition key
  を派生ツリー内に持つ master key) を供給する必要がある。 master key
  が一致しないと secret partition の読み込みステップで restore が失敗する。

### Space 横断の順序保存 {#cross-space-order-preservation}

audit chain は per-Space ではなく global に rotate する。 backup は global chain
の順序を保つ: 異なる Space の record が同じ chain segment を共有するとき、
export stream 内での相対的な emission 順序は chain hash linkage と一致する。
restore は ingest 中に global chain を検証する。順序外の ingest は早期失敗する。

## Restore のフロー {#restore-flow}

restore は 6 ステップの sequence。 各ステップは hard gate
であり、前のステップが検証されるまで次のステップは始められない。

### 1. ストレージの初期化 {#1-storage-initialization}

ターゲット storage は空、または backup を生成した kernel と同じ schema version
で初期化されている。 operator は restore 前に schema version を確認する。
cross-major restore はこのステップで reject される。target は backup
生成元と同じ kernel major / schema range に属していなければならない。

### 2. Secret master key の注入 {#2-secret-master-key-injection}

operator は record ingest の前に master key (または master key 派生材料)
を供給する。 鍵は operator の secret backend が保持し、 restore ツールは kernel
が runtime で使うのと同じ factory 経由で読み込む。

### 3. Logical import {#3-logical-import}

restore ツールは export stream を依存順にトランザクションで ingest する。

1. catalog adoption record。
2. `Approval` record。
3. `DesiredSnapshot` record。
4. `ResolutionSnapshot` record。
5. `ActivationSnapshot` record。
6. `OperationJournal` (WAL) entry、per-Space WAL cursor 順。
7. `RevokeDebt` record。
8. `AuditLog` entry。
9. secret partition entry (暗号化 blob)。

各 record の identity と内容は ingest 時に encode 済みの形と照合される。
identity 衝突は restore を abort する。

### 4. Audit chain の検証 {#4-audit-chain-verification}

`AuditLog` の ingest が終わったら、restore ツールは chain を genesis から walk
して各 hash link を検証する。 chain が壊れていれば、何の record も commit せずに
restore が abort される (失敗時にステップ 3 のトランザクションは rollback
される)。

### 5. Lock store の再構築 {#5-lock-store-reconstruction}

WAL に記録された in-flight operation を reconcile する。 terminal stage
に達していない各 operation について:

- `commit` cursor と effect digest が存在する場合、operation は completable と
  mark され、 apply pipeline は restore 後の最初の tick で
  `recoveryMode = continue` を使って完了する。
- `commit` cursor が無い場合、operation は rollback-pending と mark され、 apply
  pipeline は `recoveryMode = compensate` をスケジュールする。

cross-process lock store は in-flight operation の metadata から再構築される。
再構築が完了するまで新規 operation は dispatch されない。

### 6. ActivationSnapshot の再評価 {#6-activationsnapshot-reevaluation}

backup の activation state は authoritative な intent として復元されるが、
object ごとの health (`observe` 出力) は backup から復元 **されない** (これは
regenerable)。 restore 後の最初の observe tick が runtime-agent describe から
`ObservationSet` と `DriftIndex` を再構築する。

最初の observe tick が完了するまで、復元された object の `LifecycleStatus` は
`unknown` として報告される。 operator は復元する object 数に比例した warm-up
window を見込むべき。

## Restore 後の挙動 {#post-restore-behavior}

### DesiredSnapshot の immutability {#desiredsnapshot-immutability}

`DesiredSnapshot` record は restore 上で immutable。 backup 時点でまだ snapshot
化されていなかった desired state 変更は保存されない。 operator は再 authoring
し再 deploy する。

### In-flight operation の解決 {#in-flight-operation-resolution}

in-flight operation はステップ 5 で記録された recovery mode を通じて resume
する。 各 Implementation が `recoveryMode = continue` と
`recoveryMode = compensate` をどう扱うかは
[Provider Plugins — Implementation Contract](./providers.md#implementation-contract)
が定める。

### GroupHead と canary の状態 {#grouphead-and-canary-state}

`GroupHead` pointer と canary / shadow rollout state は `ActivationSnapshot`
の一部で、 backup 時点の通りに復元される。 30% で rollout 中だった canary は
restore 後も 30% 状態のままで、 rollout state machine は次の deploy
でその点から続行する。

## Restore の境界 {#restore-boundary}

restore は **同じ kernel major version 内でのみ保証される**。 cross-major
restore は public restore contract ではない。 restore ツールは cross-major 直接
restore を拒否し、 release-specific private runbook と検証済み evidence
を要求する closed な `failed_precondition` エラーを発行する。

## オペレーター surface {#operator-surface}

現行の public `takosumi` CLI は backup / restore コマンドを公開していない。
backup と restore は operator 限定の workflow であり、 public operator CLI
surface が実装され [CLI](./cli.md) で文書化されるまでは、 内部 control plane
ツールや deployment 自動化を通じて駆動する必要がある。

- backup は上述の point-in-time lock 下で export stream を生成する。
- restore は上記 6 ステップのフローを、初期化された空 storage に対して実行する。

両コマンドとも deploy bearer ではなく operator bearer 認証を要求する。
両コマンドとも下記 audit event を通じて進捗を記録する。

## 監査イベント {#audit-event}

backup と restore は runtime kernel event と同じ hash chain に専用 audit event
を発行する。

| Event               | Emitted at                                                      |
| ------------------- | --------------------------------------------------------------- |
| `backup-started`    | Lock acquired, before record export begins.                     |
| `backup-completed`  | Final record written and lock released.                         |
| `restore-started`   | Storage initialized and master key accepted.                    |
| `restore-completed` | Step 6 finished and the kernel transitions to normal operation. |

各 event は backup の chain head hash を運ぶ。 restore を backup
に対して検証することは、 `restore-completed` event の chain head が
`backup-completed` event の chain head と一致することの確認に等しい。

## 関連アーキテクチャノート

- docs/reference/architecture/snapshot-model.md
- docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal
- docs/reference/incident-model.md#observation-drift--revokedebt-model
- docs/reference/architecture/operational-hardening-checklist.md
- docs/reference/architecture/operator-boundaries.md

## 関連ページ

- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [Secret Partitions](./secret-partitions.md)
- [Schema Evolution](./migration-upgrade.md)
- [CLI](./cli.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Closed Enums](./closed-enums.md)
