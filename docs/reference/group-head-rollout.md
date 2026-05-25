# Reference RoutingPointer Rollout {#grouphead-rollout}

このページは reference routing implementation の Deployment の記録を説明します。 public な Takosumi rollback authority は Installation の `currentDeploymentId` に留まります。RoutingPointer と TrafficSnapshot は public core entity ではありません。

RoutingPointer は「ある group の current TrafficSnapshot」を pin する control-plane pointer です。provider data plane に同期された TrafficSnapshot assignments が runtime request の宛先になり、RoutingPointer 自体は request-time router ではありません。`currentDeploymentId` は steady state / full rollout の primary Deployment projection で、canary / shadow の split routing authority ではありません。pointer の前進 / 巻き戻しが rollout 本体です。

## アイデンティティ {#identity}

identity は `(spaceId, groupId)` の tuple で Space-local。

- `groupId` は同 Space 内で unique
- 異 Space に同じ `groupId` があっても別 RoutingPointer で、 cross-Space pointer 共有は起きない
- RoutingPointer は deployment / activation 自体ではなく pointer

## RoutingPointer レコードスキーマ {#grouphead-record-schema}

```yaml
RoutingPointer:
  spaceId: space:... # 所属 Space
  groupId: group_... # Space 内で unique
  currentDeploymentId: dep_... # primary/full-rollout deployment projection
  currentTrafficSnapshotId: act_... # reference routing evidence
  rolloutState: <enum: 7 値> # 後述
    movedAt: 2026-... # 最後に pointer が動いた時刻
```

`currentTrafficSnapshotId` が指す TrafficSnapshot の assignments が provider data plane の Exposure / traffic assignment に反映されます。 `currentDeploymentId` は UI、account layer projection、rollback target のための primary Deployment pointer です。canary / shadow 中は previous / candidate / mirror の deployment ids が TrafficSnapshot assignments に現れるため、 `currentDeploymentId` 単体を routing authority として扱いません。full rollout 確定時は `currentDeploymentId` と `currentTrafficSnapshotId` が同じ primary Deployment を表すように収束します。

## Rollout 状態機械 (closed v1 enum, 7 値) {#rollout-state-machine-closed-v1-enum-7}

新 state 追加は `CONVENTIONS.md` §6 RFC が必要です。

```text
idle | preparing | canary-active | shadow-active
     | full-rollout | rolling-back | rolled-back
```

### 各 State の意味 {#state-meaning}

| State           | 意味                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `idle`          | rollout が動いていない steady state。pointer は安定し、approval も完了済み。              |
| `preparing`     | 新 deployment が選ばれ、approval / pre-commit verification を待っている。pointer 未前進。 |
| `canary-active` | traffic 一部 (closed split) を新 deployment へ流している。健全性監視中。                  |
| `shadow-active` | production traffic を mirror して新 deployment に流す。production 結果は変えない。        |
| `full-rollout`  | 全 traffic が新 deployment に乗った。`idle` 確定前の収束観察 window。                     |
| `rolling-back`  | rollout の途中失敗で previous pointer に戻している最中。compensate / abort 進行中。       |
| `rolled-back`   | rollback が完了して previous pointer に固定された terminal observation state。            |

### 遷移規則 {#transition-rules}

- `idle → preparing`: 新 deployment が approve されて apply phase が `pre-commit` に到達したとき。
- `preparing → canary-active`: canary 配分の 1 段階目を開始したとき。 `currentTrafficSnapshotId` は split assignment を持つ新 TrafficSnapshot に切り替わる。`currentDeploymentId` は full rollout 確定まで primary projection として残り、candidate は assignments に記録する。
- `preparing → shadow-active`: shadow rollout を選択したとき。
- `canary-active → full-rollout`: 全 step を経て 100% に到達した直後。
- `shadow-active → preparing` または `shadow-active → canary-active`: shadow 観察結果が良好で、operator が次の rollout step を承認したとき。
- `full-rollout → idle`: 収束観察 window を経て stable 確定した時。
- `* → rolling-back`: rollout 進行中の任意の state から失敗・operator stop をトリガーに遷移できる (`idle` / `rolled-back` を除く)。
- `rolling-back → rolled-back`: compensate / abort が完了した時。
- `rolled-back → idle`: operator が状態を ack して新 rollout を許す段階に戻したとき (新 deployment が再選択されると `preparing` に進む)。

### 各 state で許可される operation {#allowed-operations-per-state}

| State           | 新 rollout 開始 | abort / rollback | observe 継続 |
| --------------- | --------------- | ---------------- | ------------ |
| `idle`          | 可              | 不可             | 可           |
| `preparing`     | 不可            | 可               | 可           |
| `canary-active` | 不可            | 可               | 可           |
| `shadow-active` | 不可            | 可               | 可           |
| `full-rollout`  | 不可            | 可               | 可           |
| `rolling-back`  | 不可            | -                | 可           |
| `rolled-back`   | 不可            | 不可             | 可           |

新 rollout を開始できるのは `idle` のみで、多重 rollout 交差を防ぐため他 state からの新規開始は拒否されます。

## Canary 状態 {#canary-state}

canary は traffic split を closed な比率列で進めます。

- v1 default 比率は **5% → 25% → 100%** の 3 step。 policy pack で step 列を override できますが、 step 列は OperationPlan に焼き付くため途中での ad-hoc 比率編集は approval invalidation の effect-detail change trigger を引きます。
- 各 step 昇格は IngressHealth / TrafficObservation が pass したときのみ進みます。kernel は closed health enum と policy evaluation を固定し、具体的な probe は provider / operator / kind schema 側が定義します。
- candidate release が queue に新 DataContract を出し、 preview 先 consumer が primary release のまま古い contract しか受理しない場合、 event subscription switch preview は `queue_data_contract_mismatch_requires_policy` で `blocked`。 operator policy が明示的 allow した mismatch のみ解除可。
- canary 失敗時は `rolling-back` に遷移し compensate operation 経由で previous pointer に戻します。「canary を保ったまま hold」は v1 では state として持たず、 `canary-active` に留まるか `rolling-back` に進むかの 2 択。

> Rationale: 5% は statistical signal が観測可能な production traffic 量、 25% は実需要 traffic shape で saturation 系 regression を露出、 100% は steady state 切替。 3-step は operator review burden と rollback opportunity の均衡点。

## Shadow 状態 {#shadow-state}

shadow は production traffic を新 deployment に複製送付しますが production 側挙動は変えません。

- production request / response は previous pointer から同期された provider data plane assignment (前 deployment) が処理し、client に返る
- shadow 先 (新 deployment) に同 request を mirror。結果は ObservationState に記録され、 production 側応答や副作用は変えない
- drift 検出時は [Drift Detection](./drift-detection.md) flow。 severity `error` なら operator gate で `rolling-back` に遷移
- shadow rollout は副作用 surface を持つ manifest を受け付けない。 `outputs` / `queue` delivery path / DB semantic write を含む shadow plan は `shadow-side-effects:forbidden` で resolution 時に `deny` (operator approval でも override 不可)
- read-side / invocation-side いずれも mirror。 shape 単位で適用範囲が違う場合は OperationPlan が固定

## RoutingPointer 更新のシリアライズ {#grouphead-update-serialization}

pointer 前進 / 巻き戻し / state transition は同 `(spaceId, groupId)` で直列化されます。

- 直列化は [Cross-Process Locks](./cross-process-locks.md) の `(spaceId, groupId)` key に従う
- 同 group への複数 OperationPlan interleaving は不可。 rollout 中の group へは新 rollout を載せず `idle` 確定後に開始
- lock holder 異常終了時の TTL 失効 / recovery 経路も [Cross-Process Locks](./cross-process-locks.md) の規則に従う

## 監査イベント {#audit-events}

RoutingPointer 関連の audit event は以下を発行します ([Audit Events](./audit-events.md))。

- `routing-pointer-moved`: pointer が前進した (`currentDeploymentId` または `currentTrafficSnapshotId` が変わった) ときに記録。
- `rollout-started`: `idle → preparing` または `preparing → canary-active /
  shadow-active` の遷移時。
- `rollout-completed`: `full-rollout → idle` の遷移時。
- `rollout-rolled-back`: `rolling-back → rolled-back` の遷移時。

各 event payload は `groupId` / 旧新 deploymentId / 旧新 TrafficSnapshotId / `rolloutState` 旧新を保持します。

## Future scope {#out-of-v1-scope}

- blue-green deploy は `canary-active` の最終 step (100% 切替) を replace-only mutation で表現し、旧側は ObservationState 上の watcher として `observe` 監視する。
- 複数 group の同時 coordinated rollout は future scope。current v1 は group 単位で independent に進める。

## Risk との連携 {#risk-integration}

- `traffic-change`: pointer 前進 / canary 比率変更に対し `pre-commit` で発火
- `rollback-revalidation-required`: `rolling-back` 遷移で compensate path に乗るとき発火

詳細は [Risk Taxonomy](./risk-taxonomy.md) 参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `docs/reference/architecture/ingress-routing.md` — RoutingPointer pointer と TrafficSnapshot / Exposure の関係、canary / shadow split 規則の議論
- `docs/reference/architecture/execution-lifecycle.md` — rollout state machine の閉じ方と v1 範囲を blue-green に広げない判断
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal` — pointer 前進と WAL stage の対応、シリアライズ要件の rationale

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [Lifecycle Phases](./lifecycle-phases.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Audit Events](./audit-events.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Drift Detection](./drift-detection.md)
