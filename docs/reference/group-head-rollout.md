# GroupHead Rollout

> Stability: stable Audience: operator, kernel-implementer See also:
> [Lifecycle Protocol](/reference/lifecycle),
> [Lifecycle Phases](/reference/lifecycle-phases),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Audit Events](/reference/audit-events),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Drift Detection](/reference/drift-detection)

GroupHead は Takosumi v1 で「ある group に対して現在 traffic が流れている
deployment / activation」を pin する mutable pointer です。本 reference では
GroupHead の identity、record schema、closed rollout state machine、各 state
の意味と transition 条件、canary / shadow 規則、シリアライズ要件、audit event
を固定します。

## Identity

GroupHead の identity は `(spaceId, groupId)` の tuple で、Space-local です。

- `groupId` は同一 Space 内で一意。
- 異なる Space に同じ `groupId` が存在することはあるが、それぞれは別 GroupHead
  であり、cross-Space pointer 共有は起きない。
- GroupHead は deployment / activation そのものではなく、それらを指す pointer
  であり、pointer の前進 / 巻き戻しが「rollout」の本体になる。

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
GroupHead pointer は ActivationSnapshot を介して Exposure / traffic 配分に
反映され、これが「実際にユーザ traffic が向かう先」になります。

## Rollout state machine (closed v1 enum, 7 値)

`rolloutState` は閉じた 7 値 enum です。新 state 追加は `CONVENTIONS.md` §6 RFC
を要します。

```text
idle | preparing | canary-active | shadow-active
     | full-rollout | rolling-back | rolled-back
```

### State 意味

| State           | 意味                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `idle`          | rollout が動いていない steady state。pointer は安定し、approval も完了済み。       |
| `preparing`     | 新 deployment が選ばれ、approval / pre-commit hook を待っている。pointer 未前進。  |
| `canary-active` | traffic 一部 (closed split) を新 deployment へ流している。健全性監視中。           |
| `shadow-active` | production traffic を mirror して新 deployment に流す。production 結果は変えない。 |
| `full-rollout`  | 全 traffic が新 deployment に乗った。`idle` 確定前の収束観察 window。              |
| `rolling-back`  | rollout の途中失敗で旧 pointer に戻している最中。compensate / abort 進行中。       |
| `rolled-back`   | rollback が完了して旧 pointer に固定された terminal observation state。            |

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

新 rollout を開始できるのは `idle` のみで、他 state からの新規開始は拒否
されます。多重 rollout の交差を防ぐためです。

## Canary state

canary では traffic split を closed な比率列で進めます。

- v1 default 比率は **5% → 25% → 100%** の 3 step です。policy pack で step 列を
  override できますが、step 列は OperationPlan に焼き付き、 途中での比率 ad-hoc
  編集は approval invalidation の effect-detail change trigger
  を引きます。Rationale: 5% は典型的な production traffic 量で statistical
  signal が観測可能、25% は実需要 traffic shape を経験させて saturation 系
  regression を露出、100% は steady state 切り替え。3-step は operator review
  burden を抑えつつ各 step で rollback opportunity を 保つ均衡点。
- 各 step の昇格は readiness probe / observe 結果が pass したときのみ進み
  ます。pass 条件は kernel が固定し、provider plugin は独自に override
  できません。
- canary 失敗時は **`rolling-back` に遷移**し、compensate hook を経由して 旧
  pointer に戻します。途中段階で停止する「canary を保ったまま hold」 は v1 では
  state として持ちません。`canary-active` に留まったまま operator
  が判断するか、`rolling-back` に進むかの 2 択です。

## Shadow state

shadow では production traffic を新 deployment にも複製送付し、production
側の挙動には影響しません。

- production への request / response は `currentActivationSnapshotId` の前
  pointer (旧 deployment) が処理し、結果は client に返ります。
- shadow 先 (新 deployment) に同じ request を mirror します。mirror 結果は
  ObservationSet に記録され、production 側の応答や副作用を変えません。
- shadow 結果から drift が検出された場合は通常の
  [Drift Detection](/reference/drift-detection) flow に乗ります。 drift severity
  が `error` であれば operator gate で `rolling-back` に
  遷移させる運用にします。
- shadow は read-side / invocation-side のいずれも mirror しますが、 shape
  単位で mirror 適用範囲が異なる場合は OperationPlan が固定します。

## GroupHead update のシリアライズ

GroupHead pointer の前進 / 巻き戻し / state transition は同一
`(spaceId,
groupId)` で **直列化** されます。

- シリアライズは [Cross-Process Locks](/reference/cross-process-locks) の
  `(spaceId, groupId)` key に従います。
- 同 group に対する複数 OperationPlan の interleaving は許されません。 rollout
  中の group には新 rollout を載せず、`idle` 確定後に開始します。
- lock holder 異常終了時の TTL 失効・recovery 経路も
  [Cross-Process Locks](/reference/cross-process-locks) の規則に従います。

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

- **blue-green deploy** は v1 では独立 state として持ちません。代わりに
  `canary-active` の最終 step (100% 切り替え) を replace-only mutation で
  表現します。新 ActivationSnapshot に一気に切り替え、旧側は ObservationSet 上の
  watcher として `observe` 経由で監視するだけに 留めます。
- **複数 group の同時 coordinated rollout** は v1 範囲外。group 単位で
  independent に rollout を進める運用が前提です。

## Risk との連携

- `traffic-change` Risk は GroupHead pointer の前進 / canary 比率変更に 対して
  `pre-commit` で発火する。詳細は [Risk Taxonomy](/reference/risk-taxonomy)
  を参照。
- `rollback-revalidation-required` Risk は `rolling-back` への遷移で compensate
  path に乗るとき発火する。

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る。

- `docs/design/exposure-activation-model.md` — GroupHead pointer と
  ActivationSnapshot / Exposure の関係、canary / shadow split 規則の議論
- `docs/design/execution-lifecycle.md` — rollout state machine の閉じ方と v1
  範囲を blue-green に広げない判断
- `docs/design/operation-plan-write-ahead-journal-model.md` — pointer 前進と WAL
  stage の対応、シリアライズ要件の rationale
