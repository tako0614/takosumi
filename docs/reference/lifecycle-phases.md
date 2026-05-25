# Lifecycle Phases

このページは Takosumi reference 実装の internal execution phases を定義します。
public Installer API から見える status は Deployment / Installation の wire shape
であり、ここにある `Phase` / `LifecycleStatus` は Deployment の記録と recovery
に使う internal enum です。

Takosumi reference 実装 v1 lifecycle は OperationPlan ごとに走る 6 phase closed
enum と、managed object の可視状態を表す 5 値 `LifecycleStatus` closed enum
の組合せ。値の追加には `CONVENTIONS.md` §6 RFC が必須です。

```text
Phases:           apply | activate | destroy | rollback | recovery | observe
LifecycleStatus:  running | stopped | missing | error | unknown
```

phase は `(spaceId, operationPlanDigest, journalEntryId)` を key に WAL stage
進行を駆動します。 `LifecycleStatus` は runtime-agent describe / kernel observe
loop の報告値で、 apply pipeline の入力にはなりません。

## Phase enum

```text
apply  ──►  activate  ──►  observe   (steady state)
                │
                └──►  destroy
                │
rollback ◄──────┘     (pointer move to retained Deployment)
recovery ◄── (kernel restart / lock re-acquire,
              resumes from last persisted WAL stage)
```

`observe` は長時間動作で、同 Space の次 `apply` / `destroy` と重なっても block
しません。 `rollback` / `recovery` は常に WAL replay で、最後に persist された
journal entry から再入します。

### `apply`

- **Input**: manifest 由来 TargetState + 既存 Space の前回
  `ResolvedPlan` (あれば)
- **Output**: 新 `ResolvedPlan` と bind 済 `OperationPlan`、リソースの作成・更新
  の記録
- **Journal cursor**: operation ごとに新 `journalEntryId` を割当て、
  `(spaceId, operationPlanDigest, journalEntryId)` を記録
- **WAL stages**: `prepare` -> `pre-commit` -> `commit` -> `post-commit` ->
  `finalize`
- **Failure**: `prepare` / `pre-commit` 失敗は副作用なく `abort`。`commit`
  失敗は同じ internal WAL idempotency key で retry するか、operator が recovery
  mode を選ぶ
- **Blocking**: 期間中 `(spaceId, operationPlanDigest)` lock を保持。同 Space
  の他 intentional phase は queue
- **Typical duration**: 数秒〜数分。 OCI image pull / Transform 含む plan は
  connector apply 待ちが支配的

### `activate`

- **Input**: `apply` が生成した `ResolvedPlan`
- **Output**: TrafficSnapshot / RoutingPointer update。health は observe が
  append-only observation として記録する。新 `ResolvedPlan` は生成しない
- **Journal cursor**: apply phase の entry を `commit` -> `post-commit` 遷移で
  継続使用
- **WAL stages**: `post-commit` -> `observe`
- **Failure**: `post-commit` 失敗は provider side effect を rollback せず
  CleanupBacklog を enqueue し、observe loop が reconcile。`compensate` recovery
  選択時は `activation-rollback` CleanupBacklog を emit
- **Blocking**: 元 `apply` と同じ lock を保持
- **Typical duration**: 1 分未満。 connector traffic flip / DNS / readiness 伝
  播が支配的

### `destroy`

- **Input**: 現行 Deployment の recorded `ResolvedPlan` / operation の記録
- **Output**: 新しい destroy operation の記録 / WAL cleanup result /
  activation state。旧 `ResolvedPlan` は変更しない。external /
  operator-owned input refs は不変
- **Journal cursor**: destroy plan digest の下で新 `journalEntryId` を割当て
- **WAL stages**: `pre-commit` -> `commit` -> `finalize`
- **Failure**: `commit` 失敗で部分削除が残り、 recovery は resume (idempotent)
  か pre-destroy snapshot への compensate を選択。 `finalize` で external
  connector が削除を拒否すれば `external-revoke` `CleanupBacklog` を emit
- **Blocking**: 同 lock。 `apply` と相互排他
- **Typical duration**: `apply` 相当。削除が緩慢な external resource で長く
  なりうる

### `rollback`

- **Input**: 巻き戻し対象 Deployment の recorded source / snapshot / 記録
- **Public output**: `Installation.currentDeploymentId` が target Deployment
  を指 す。Deployment は新規作成しない
- **Reference implementation output**: internal routing / activation pointer
  update。具体的な pointer 名は implementation detail
- **Journal cursor**: 新 `journalEntryId`。 rollback plan は独自の
  `operationPlanDigest` を持つ
- **WAL stages**: `pre-commit` -> `commit` -> `post-commit` -> `finalize`
- **Failure**: 記録済 Deployment / TrafficSnapshot が利用不能、または
  pointer update を atomic に commit できない場合は `abort`。unfinished WAL の
  cleanup / compensate は `recovery` phase で扱う
- **Blocking**: 前方 phase と同じ lock
- **Typical duration**: pointer update と provider ingress assignment
  の反映時間。 DB / object-store contents や migration は巻き戻さない

### `recovery`

- **Input**: persist 済 WAL state + unfinished journal entry に記録された
  snapshot / 記録 ids
- **Output**: recovery mode (`normal` / `continue` / `compensate` / `inspect`)
  に依存。詳細は [Recovery modes](./lifecycle.md#recovery-modes)
- **Journal cursor**: 最後に persist された entry の次 stage から resume。新
  `journalEntryId` は割当てない
- **WAL stages**: resume point 以降の残り stage
- **Failure**: mode 依存。 `inspect` は副作用なし、 `compensate` は `CleanupBacklog`
  を emit する場合あり
- **Blocking**: resume 対象 phase と同じ lock
- **Typical duration**: 元 phase に残っていた作業量に従う

### `observe`

- **Input**: live runtime-agent describe 結果 + 現行 `ResolvedPlan`
- **Output**: health observation (`healthy` / `degraded` / `unhealthy`)、
  ObservationState entry、 drift / external revoke 検出時の `CleanupBacklog` 候補
- **Journal cursor**: Space ごとに長時間 observe entry を再利用。新 operation
  plan digest は割当てない
- **WAL stages**: `observe` (long-lived、 terminal にならない)
- **Failure**: 非 blocking。 freshness annotation は立てるが compensate effect
  は実行しない
- **Blocking**: apply lock は保持せず、 steady-state traffic と並行動作
- **Typical duration**: 継続的

## `LifecycleStatus` enum

`LifecycleStatus` は runtime-agent が backing connector 上の managed object に
ついて報告する 5 値の観測 state です。control plane phase は上記 Lifecycle
Phase で扱います。

```text
running | stopped | missing | error | unknown
```

| 値        | 意味                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| `running` | object が存在し、 component kind contract に従って connector の「live」状態にある。           |
| `stopped` | object は存在するが意図的に動作していない (例: paused worker、 drained gateway)。                |
| `missing` | connector 視点で object が不在。未 apply か、外部から削除されたかのいずれか。                    |
| `error`   | object は存在するが connector が通常動作不能の fault を報告している。                            |
| `unknown` | connector が応答しない、未知の state を返した、または runtime-agent がまだ describe していない。 |

### Trigger transitions

```text
apply trigger:
  unknown -> running     (managed object materialized successfully)
  unknown -> error       (provider reported failure during commit)
  missing -> running     (re-applied after external delete; may emit CleanupBacklog)
  error   -> running     (subsequent apply healed the fault)

describe trigger:
  running -> running     (steady-state confirm)
  running -> stopped     (intentional drain detected)
  running -> error       (connector now reports fault)
  running -> missing     (external delete; emits CleanupBacklog of reason
                          external-revoke)
  any     -> unknown     (describe failed / connector unreachable)

destroy trigger:
  running -> missing     (managed delete completed)
  stopped -> missing     (managed delete completed)
  error   -> missing     (forced delete on a faulted object)
  missing -> missing     (idempotent destroy)

verify trigger:
  no transition          (verify never mutates LifecycleStatus)
```

`verify` は read-only trigger で、 connector 自体について `connector_not_found`
/ `connector_failed` を返すのみ。 managed object の `LifecycleStatus` は更新し
ません。

### 報告ルール

runtime-agent は describe ごと、および `apply` / `destroy` の lifecycle response
で `LifecycleStatus` を返します。ルール:

- component kind contract に従い connector が live と確認したときのみ `running`
  (accept されただけでは不可)
- connector が応答しない / 未知 state を返したら推測せず `unknown`
- connector が「object 不在」を権威的に保証した場合のみ `missing` (沈黙は
  missing としない)
- connector が明示的に fault を報告したときのみ `error`。 fault detail は
  describe envelope で伝搬

## 関連 architecture notes

- `docs/reference/architecture/execution-lifecycle.md` — phase 数を 6
  に絞った理由と observe / recovery を独立 phase として残す decision
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — phase と WAL stage の対応関係、idempotency tuple の設計
- `docs/reference/architecture/runtime-agent-boundary.md` —
  `LifecycleStatus` を 5 値に閉じる根拠と describe 報告規約

## 関連ページ

- [Enum and Value Index](./closed-enums.md)
- [Lifecycle Protocol](./lifecycle.md)
- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)
