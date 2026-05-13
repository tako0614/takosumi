# Lifecycle Phases

> このページでわかること: resource のライフサイクルフェーズ定義。

Takosumi v1 の lifecycle は OperationPlan ごとに適用される 6 phase の closed
enum と、 各 managed object の backing connector 上の可視状態を表す 5 値
`LifecycleStatus` closed enum の組み合わせです。 いずれも closed で、 値の追加
には `CONVENTIONS.md` §6 RFC が必須です。

```text
Phases:           apply | activate | destroy | rollback | recovery | observe
LifecycleStatus:  running | stopped | missing | error | unknown
```

phase enum は `(spaceId, operationPlanDigest, journalEntryId)` を key とした WAL
stage 進行を駆動します。 `LifecycleStatus` は runtime-agent describe と kernel
observe loop が報告するもので、 apply pipeline の入力にはなりません。

## Phase enum

```text
apply  ──►  activate  ──►  observe   (steady state)
                │
                └──►  destroy
                │
rollback ◄──────┘     (re-materialize prior ResolutionSnapshot)
recovery ◄── (kernel restart / lock re-acquire,
              resumes from last persisted WAL stage)
```

`observe` は長時間動作で、 同一 Space 上の次の `apply` / `destroy` と重なり
ますが、 それらを block しません。 `rollback` / `recovery` は常に WAL replay
で、 最後に persist された journal entry から再入します。

### `apply`

- **Input snapshot**: manifest 由来の DesiredSnapshot と、 既存があればその
  Space の前回 `ResolutionSnapshot`
- **Output snapshot**: 新しい `ResolutionSnapshot` とそれに bind された
  `OperationPlan`
- **Journal cursor**: operation ごとに新 `journalEntryId` を割当て、
  `(spaceId, operationPlanDigest, journalEntryId)` を記録
- **WAL stages**: `prepare` -> `pre-commit` -> `commit`
- **Failure**: `prepare` 中の失敗は副作用なく plan を破棄。 `pre-commit` 中の
  失敗は同一 WAL entry に紐付く compensate を実行。 `commit` 中の失敗は entry を
  `commit-failed` に marking し、 recovery が resume か compensate かを決 定
- **Blocking**: 期間中 `(spaceId, operationPlanDigest)` の cross-process lock
  を保持。 同一 Space の他 intentional phase は queue 待ち
- **Typical duration**: 一般的な manifest で数秒〜数分。 OCI image pull や
  Transform を含む plan では connector apply 待ち時間が支配的

### `activate`

- **Input snapshot**: `apply` が生成した `ResolutionSnapshot`
- **Output snapshot**: connector 側の activation 副作用、 Exposure health は
  `unknown` で初期化。 新たな `ResolutionSnapshot` は生成しない
- **Journal cursor**: apply phase の journal entry を `commit` -> `post-commit`
  遷移で引き続き使用
- **WAL stages**: `commit` -> `post-commit`
- **Failure**: `post-commit` 失敗は effect を rollback せず、
  `post-commit-failed` annotation を立てる。 observe loop が後続で reconcile
  する。 operator が `compensate` recovery を選択した場合は
  `activation-rollback` の `RevokeDebt` を emit
- **Blocking**: 元 `apply` と同じ lock を保持
- **Typical duration**: 1 分未満。 connector の traffic flip / DNS / readiness
  伝播が支配的

### `destroy`

- **Input snapshot**: 現行 `ResolutionSnapshot`
- **Output snapshot**: managed / generated lifecycle-class object を削除した
  `ResolutionSnapshot`。 external / operator / imported は不変
- **Journal cursor**: destroy plan digest の下で新 `journalEntryId` を割当て
- **WAL stages**: `pre-commit` -> `commit` -> `finalize`
- **Failure**: `commit` 失敗は object が部分削除のまま残り、 recovery は resume
  (idempotent) または pre-destroy snapshot への compensate を選ぶ。 `finalize`
  で external connector が削除を拒否した場合は `external-revoke` の `RevokeDebt`
  を emit
- **Blocking**: 同じ lock。 `apply` と相互排他
- **Typical duration**: `apply` 相当。 削除が緩慢な external resource では長
  くなりうる

### `rollback`

- **Input snapshot**: 巻き戻し対象の 1 つ前の `ResolutionSnapshot`
- **Output snapshot**: その以前 snapshot を connector 上に再 materialize
- **Journal cursor**: 新 `journalEntryId`。 rollback plan は独自の
  `operationPlanDigest` を持つ
- **WAL stages**: `pre-commit` (compensate replay) -> `commit` -> `abort`
- **Failure**: compensate を適用できない entry があれば rollback は `abort`
  へ遷移し、 `activation-rollback` の `RevokeDebt` を emit
- **Blocking**: 前方 phase と同じ lock
- **Typical duration**: 元 `apply` と同程度。 最も遅い compensate operation が
  boundary

### `recovery`

- **Input snapshot**: persist 済み WAL state と Space の最新
  `ResolutionSnapshot`
- **Output snapshot**: recovery mode (`normal` / `continue` / `compensate` /
  `inspect`) に依存。 詳細は
  [Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes)
- **Journal cursor**: 最後に persist された entry の次 stage から resume。 既存
  operation に新 `journalEntryId` を割当てない
- **WAL stages**: resume point 以降の残り stage
- **Failure**: mode 依存。 `inspect` は副作用なし、 `compensate` は `RevokeDebt`
  を emit する場合あり
- **Blocking**: resume 対象 phase と同じ cross-process lock を取得
- **Typical duration**: 元 phase に残っていた作業量に従う

### `observe`

- **Input snapshot**: live runtime-agent describe 結果と現行
  `ResolutionSnapshot`
- **Output snapshot**: Exposure health 遷移 (`unknown` -> `observing` ->
  `healthy` / `degraded` / `unhealthy`)、 ObservationSet entry、 drift /
  external revoke 検出時の `RevokeDebt` 候補
- **Journal cursor**: Space ごとに長時間の observe entry を再利用。 新規
  operation plan digest は割当てない
- **WAL stages**: `observe` (long-lived、 terminal にならない)
- **Failure**: observe 失敗は非 blocking。 freshness annotation は立てるが、
  compensate effect は実行しない
- **Blocking**: apply lock は保持せず、 steady-state traffic と並行動作
- **Typical duration**: 継続的

## `LifecycleStatus` enum

5 値の `LifecycleStatus` enum は runtime-agent が backing connector 上の managed
object について報告する値です。 観測 state であり、 control plane phase
ではありません。

```text
running | stopped | missing | error | unknown
```

| 値        | 意味                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| `running` | object が存在し、 shape の contract に従って connector の「live」状態にある。                      |
| `stopped` | object は存在するが意図的に動作していない (例: paused worker、 drained gateway)。                  |
| `missing` | connector 視点で object が不在。 未 apply か、 外部から削除されたかのいずれか。                    |
| `error`   | object は存在するが connector が通常動作不能の fault を報告している。                              |
| `unknown` | connector が応答しない、 未知の state を返した、 または runtime-agent がまだ describe していない。 |

### Trigger transitions

```text
apply trigger:
  unknown -> running     (managed object materialized successfully)
  unknown -> error       (provider reported failure during commit)
  missing -> running     (re-applied after external delete; may emit RevokeDebt)
  error   -> running     (subsequent apply healed the fault)

describe trigger:
  running -> running     (steady-state confirm)
  running -> stopped     (intentional drain detected)
  running -> error       (connector now reports fault)
  running -> missing     (external delete; emits RevokeDebt of reason
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
/ `connector_failed` を返すのみ。 managed object の `LifecycleStatus`
を更新することはありません。

### 報告ルール

runtime-agent は describe ごと、 および `apply` / `destroy` の lifecycle
response で `LifecycleStatus` を返します。 以下のルールに従う必要があります。

- shape contract に従って connector が live と確認したときのみ `running` を 返す
  (accept されただけでは不可)
- connector が応答しない / 未知の state を返したときは推測せず `unknown`
- connector が「object 不在」を権威的に保証している場合のみ `missing` を返 す
  (沈黙は missing とみなさない)
- connector が明示的に fault を報告したときのみ `error` を返し、 fault detail は
  describe envelope で伝搬する

## 関連 architecture notes

- `docs/reference/architecture/execution-lifecycle.md` — phase 数を 6
  に絞った理由と observe / recovery を独立 phase として残す decision
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  phase と WAL stage の対応関係、idempotency tuple の設計
- `docs/reference/architecture/implementation-operation-envelope.md` —
  `LifecycleStatus` を 5 値に閉じる根拠と describe 報告 contract

## 関連ページ

- [Closed Enums](/reference/closed-enums)
- [Lifecycle Protocol](/reference/lifecycle)
- [Runtime-Agent API](/reference/runtime-agent-api)
