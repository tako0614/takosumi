# GroupHead Rollout

> このページでわかること: GroupHead pointer / rollout state machine / canary
> / shadow / audit event。

GroupHead は「ある group に現在 traffic が流れている deployment / activation」
を pin する mutable pointer。 pointer の前進 / 巻き戻しが rollout 本体です。

## Identity

identity は `(spaceId, groupId)` の tuple で Space-local。

- `groupId` は同 Space 内で unique
- 異 Space に同じ `groupId` があっても別 GroupHead で、 cross-Space pointer
  共有は起きない
- GroupHead は deployment / activation 自体ではなく pointer

## GroupHead record schema

```yaml
GroupHead:
  spaceId: space:... # 所属 Space
  groupId: group:... # Space 内で unique
  currentDeploymentId: deployment:... # pointer 先 deployment
  currentActivationSnapshotId: activation:... # pointer 先 ActivationSnapshot
  rolloutState: <enum: 7 値> # 後述
    movedAt: 2026-... # 最後に pointer が動いた時刻
```

`currentDeploymentId` / `currentActivationSnapshotId` は同時に更新されます。
pointer は ActivationSnapshot を介して Exposure / traffic 配分に反映され、
ユーザ traffic の宛先になります。

## Rollout state machine (closed v1 enum, 7 値)

新 state 追加は `CONVENTIONS.md` §6 RFC が必要です。

```text
idle | preparing | canary-active | shadow-active
     | full-rollout | rolling-back | rolled-back
```

### State 意味

| State           | 意味                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `idle`          | rollout が動いていない steady state。pointer は安定し、approval も完了済み。              |
| `preparing`     | 新 deployment が選ばれ、approval / pre-commit verification を待っている。pointer 未前進。 |
| `canary-active` | traffic 一部 (closed split) を新 deployment へ流している。健全性監視中。                  |
| `shadow-active` | production traffic を mirror して新 deployment に流す。production 結果は変えない。        |
| `full-rollout`  | 全 traffic が新 deployment に乗った。`idle` 確定前の収束観察 window。                     |
| `rolling-back`  | rollout の途中失敗で previous pointer に戻している最中。compensate / abort 進行中。       |
| `rolled-back`   | rollback が完了して previous pointer に固定された terminal observation state。            |

### Transition 規則

- `idle → preparing`: 新 deployment が approve されて apply phase が
  `pre-commit` に到達したとき。
- `preparing → canary-active`: canary 配分の 1 段階目を開始したとき (pointer は
  GroupHead の semantics 上、canary 比率を反映するが
  `currentActivationSnapshotId` は新 ActivationSnapshot に切り替わる)。
- `preparing → shadow-active`: shadow rollout を選択したとき。
- `canary-active → full-rollout`: 全 step を経て 100% に到達した直後。
- `shadow-active → preparing` または `shadow-active → canary-active`: shadow
  観察結果が良好で、operator が次の rollout step を承認したとき。
- `full-rollout → idle`: 収束観察 window を経て stable 確定した時。
- `* → rolling-back`: rollout 進行中の任意の state から失敗・operator stop
  をトリガーに遷移できる (`idle` / `rolled-back` を除く)。
- `rolling-back → rolled-back`: compensate / abort が完了した時。
- `rolled-back → idle`: operator が状態を ack して新 rollout を許す段階に戻
  したとき (新 deployment が再選択されると `preparing` に進む)。

### 各 state で許可される operation

| State           | 新 rollout 開始 | abort / rollback | observe 継続 |
| --------------- | --------------- | ---------------- | ------------ |
| `idle`          | 可              | 不可             | 可           |
| `preparing`     | 不可            | 可               | 可           |
| `canary-active` | 不可            | 可               | 可           |
| `shadow-active` | 不可            | 可               | 可           |
| `full-rollout`  | 不可            | 可               | 可           |
| `rolling-back`  | 不可            | -                | 可           |
| `rolled-back`   | 不可            | 不可             | 可           |

新 rollout を開始できるのは `idle` のみで、 多重 rollout 交差を防ぐため他
state からの新規開始は拒否されます。

## Canary state

canary は traffic split を closed な比率列で進めます。

- v1 default 比率は **5% → 25% → 100%** の 3 step。 policy pack で step 列を
  override できますが、 step 列は OperationPlan に焼き付くため途中での ad-hoc
  比率編集は approval invalidation の effect-detail change trigger を引きます。
- 各 step 昇格は readiness probe / observe 結果が pass したときのみ進みます。
  pass 条件は kernel が固定し provider plugin は override 不可。
- candidate release が queue に新 DataContract を出し、 preview 先 consumer が
  primary release のまま古い contract しか受理しない場合、 event subscription
  switch preview は `queue_data_contract_mismatch_requires_policy` で
  `blocked`。 operator policy が明示的 allow した mismatch のみ解除可。
- canary 失敗時は `rolling-back` に遷移し compensate operation 経由で previous
  pointer に戻します。 「canary を保ったまま hold」 は v1 では state として持
  たず、 `canary-active` に留まるか `rolling-back` に進むかの 2 択。

> Rationale: 5% は statistical signal が観測可能な production traffic 量、 25%
> は実需要 traffic shape で saturation 系 regression を露出、 100% は steady
> state 切替。 3-step は operator review burden と rollback opportunity の均衡
> 点。

## Shadow state

shadow は production traffic を新 deployment に複製送付しますが production 側
挙動は変えません。

- production request / response は previous pointer (前 deployment) が処理し
  client に返る
- shadow 先 (新 deployment) に同 request を mirror。 結果は ObservationSet に
  記録され、 production 側応答や副作用は変えない
- drift 検出時は [Drift Detection](/reference/drift-detection) flow。 severity
  `error` なら operator gate で `rolling-back` に遷移
- shadow rollout は副作用 surface を持つ manifest を受け付けない。 `outputs` /
  `queue` route / DB semantic write を含む shadow plan は
  `shadow-side-effects:forbidden` で resolution 時に `deny` (operator approval
  でも override 不可)
- read-side / invocation-side いずれも mirror。 shape 単位で適用範囲が違う場
  合は OperationPlan が固定

## GroupHead update のシリアライズ

pointer 前進 / 巻き戻し / state transition は同 `(spaceId, groupId)` で直列化
されます。

- 直列化は [Cross-Process Locks](/reference/cross-process-locks) の
  `(spaceId, groupId)` key に従う
- 同 group への複数 OperationPlan interleaving は不可。 rollout 中の group へ
  は新 rollout を載せず `idle` 確定後に開始
- lock holder 異常終了時の TTL 失効 / recovery 経路も
  [Cross-Process Locks](/reference/cross-process-locks) の規則に従う

## Audit events

GroupHead 関連の audit event は以下を発行します
([Audit Events](/reference/audit-events))。

- `group-head-moved`: pointer が前進した (`currentDeploymentId` /
  `currentActivationSnapshotId` のいずれかが変わった) ときに記録。
- `rollout-started`: `idle → preparing` または
  `preparing → canary-active /
  shadow-active` の遷移時。
- `rollout-completed`: `full-rollout → idle` の遷移時。
- `rollout-rolled-back`: `rolling-back → rolled-back` の遷移時。

各 event payload は `groupId` / 旧新 deploymentId / 旧新 ActivationSnapshotId /
`rolloutState` 旧新を保持します。

## v1 範囲外

- blue-green deploy は独立 state として持ちません。 `canary-active` の最終
  step (100% 切替) を replace-only mutation で表現し、 旧側は ObservationSet
  上の watcher として `observe` 監視するだけに留めます。
- 複数 group の同時 coordinated rollout は v1 範囲外。 group 単位で
  independent に進めます。

## Risk との連携

- `traffic-change`: pointer 前進 / canary 比率変更に対し `pre-commit` で発火
- `rollback-revalidation-required`: `rolling-back` 遷移で compensate path に
  乗るとき発火

詳細は [Risk Taxonomy](/reference/risk-taxonomy) 参照。

## Related architecture notes

関連 architecture notes:��

- `docs/reference/architecture/exposure-activation-model.md` — GroupHead pointer
  と ActivationSnapshot / Exposure の関係、canary / shadow split 規則の議論
- `docs/reference/architecture/execution-lifecycle.md` — rollout state machine
  の閉じ方と v1 範囲を blue-green に広げない判断
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  pointer 前進と WAL stage の対応、シリアライズ要件の rationale

## 関連ページ

- [Lifecycle Protocol](/reference/lifecycle)
- [Lifecycle Phases](/reference/lifecycle-phases)
- [Cross-Process Locks](/reference/cross-process-locks)
- [Audit Events](/reference/audit-events)
- [Risk Taxonomy](/reference/risk-taxonomy)
- [Drift Detection](/reference/drift-detection)
