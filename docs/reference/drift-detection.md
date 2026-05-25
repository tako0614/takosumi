# Drift Detection

## DriftIndex

DriftIndex は reference kernel internal drift model の集約 record です。1 つの
ResolutionSnapshot に対して 0 件以上の drift entry を保持し、status surface と
ActivationSnapshot annotation 経由で operator に可視化されます。Provider /
operator 独自の observation taxonomy は、この reference model の外側に追加でき
ます。

DriftIndex 自身は **DesiredSnapshot を mutate しません**。これは v1 invariant
です。DesiredSnapshot は operator-authored を起点にした WAL stage 経由でしか
書き換わらず、drift によって自動上書きされることはありません。

## Compute trigger

DriftIndex の compute は以下のいずれかで起動します。

- **observe phase 完了後の自動 compute**: `observe` stage が回って
  ObservationSet が更新されるたびに、kernel が対応する DesiredSnapshot との diff
  を取り、DriftIndex を再生成します。これは observe loop の通常経路です。
- **operator-initiated re-observe**: operator が CLI から手動で re-observe
  を要求した場合、kernel は対象 ResolutionSnapshot に対する observe
  を促し、その完了に同じ自動 compute path が乗ります。手動 trigger は WAL stage
  を進めず、DriftIndex の生成タイミングだけを早めます。

compute は idempotent で、同じ
`(spaceId, resolutionSnapshotId,
observationSetDigest)` tuple で再走しても
DriftIndex は同一内容に収束します。

## Compute 方法

DriftIndex は DesiredSnapshot と ObservationSet を field-by-field で比較し、
不一致を drift entry に変換します。

- **field-by-field 比較**: DesiredSnapshot 上の declared object と
  ObservationSet 上の observed object を address (object identity) ごとに pair
  し、kernel が宣言する比較 field 集合に対して値を突き合わせます。
- **kind 不一致**: declared 側の kind と observed 側の kind が一致しない
  ケースは drift entry を生成します。例えば DesiredSnapshot 上は present で
  ObservationSet 上では missing、あるいは declared 上の lifecycle class が
  managed なのに observed が unmanaged shape を返した場合などです。
- **severity 判定**: drift entry には `warning` / `error` のいずれかが付き
  ます。`error` は observe 結果が DesiredSnapshot と矛盾し、これ以上の traffic
  shift が安全に進められない状態を示します。`warning` は drift は
  あるが観測の遅延 / observe 周期内で収束見込みが残るケースです。

比較対象 field 集合と severity 判定規則は reference drift model が固定します。
Provider / operator status surface は独自 drift taxonomy を別 surface として追加
できます。

## Drift entry schema

DriftIndex に格納される個々の drift entry は以下の field を持ちます。

```yaml
DriftEntry:
  address: <object address> # drift が観測された対象
  kind: <enum> # 例: stale-secret-projection / missing-managed-object / unmanaged-collision
  severity: <warning | error>
  detectedAt: 2026-... # DriftIndex compute 時刻
  observationDigest: <sha256> # 元 ObservationSet の digest
```

`DriftEntry.kind` は component kind ではなく、reference drift model が管理する
internal drift category です。新 category 追加は `CONVENTIONS.md` §6 RFC
を要します。`observationDigest` は entry を 生んだ ObservationSet
を一意に固定し、後で operator が origin observation を再現できるようにします。

## Propagation path (固定)

drift の propagation path は 1 本に固定されています。

```
ObservationSet
   ↓ (observe phase 完了)
DriftIndex compute
   ↓
ActivationSnapshot annotation
   ↓
status surface (operator visibility)
   ↓
approval invalidation (binding が崩れた場合)
```

- DriftIndex は ActivationSnapshot に annotation として伝播し、当該
  ActivationSnapshot が運ぶ traffic 配分の前提が崩れたかを記録します。
- status surface (operator UI / CLI status / operator deploy gate) はこの
  annotation を読んで drift 件数 / severity を表示します。
- 影響する binding がある場合、approval invalidation の対応 trigger に従って
  approval が `invalidated` 状態に落ちます。drift 自体が直接 invalidation
  を起こすのではなく、drift によって binding 前提が崩れた際に
  [Approval Invalidation Triggers](./approval-invalidation.md) 上の対応 trigger
  が発火します。

## RevokeDebt との関係

drift によって「DesiredSnapshot 上は無い管理外 object が observed 上に
残っている」「逆に DesiredSnapshot 上は generated として宣言した object が
observed 上に存在しない」といった状況が見つかった場合、kernel は
[RevokeDebt](./revoke-debt.md) を生成して cleanup queue に乗せます。

- drift で discovered な missing object (declared generated だが observed
  missing) は、対応する RevokeDebt entry を `reason:
  activation-rollback`
  または `reason: external-revoke` で生成します。
- drift で discovered な unmanaged collision は、`collision-detected` Risk と
  RevokeDebt 生成の両経路に分岐します。RevokeDebt 化するか Risk
  表示にとどめるかは drift entry の severity に従います。

DriftIndex 自体は RevokeDebt を mutate しません。RevokeDebt の status transition
は [RevokeDebt Model](./revoke-debt.md) の規則に従い、 DriftIndex 側は entry の
`observationDigest` を介して紐付けを保つだけです。

## Activation rollback の経路

drift が原因で「もう traffic を進められない」と operator が判断した場合、
rollback は **DesiredSnapshot を直接編集する経路を取りません**。

- rollback は activation lifecycle 経由で発火させます
  ([Lifecycle Protocol](./lifecycle.md) の `rollback` phase)。
- rollback の WAL は通常通り `pre-commit` → `commit` → `post-commit` →
  `finalize` を辿ります。compensate / abort は unfinished WAL の recovery path
  に限定します。
- DriftIndex は rollback 完了後に再 compute され、drift entry が解消
  されたか、別の drift に置き換わったかを反映します。

これにより drift 起因の rollback も、通常の activation lifecycle と同じ WAL /
approval / RevokeDebt の枠組みに乗ります。

## Operator visibility

DriftIndex は以下の operator surface に露出します。

- **status 表示**: `takosumi status` 系コマンドで Space 単位の drift 件数と
  severity 別 breakdown を表示します。
- **plan / preview 表示**: 次 apply の plan 出力時に、現 ResolutionSnapshot
  に紐づく DriftIndex を annotation として併記します。operator が drift
  を承知の上で apply を進めるかを判断する材料になります。
- **operator deploy gate**: production 配置では `error` severity の drift entry
  が 1 件でもあると deploy gate 失敗扱いにします。`/readyz` は kernel
  control-plane readiness であり、workload / exposure drift 判定には使いません。
- **audit events**: drift entry の発生・解消は `drift-detected` audit event
  として記録されます (詳細は [Audit Events](./audit-events.md))。

## Operator-initiated re-observe

operator が手動で re-observe を要求する経路は internal control-plane tooling で
提供します。current public `takosumi` CLI には observe / drift subcommand は
ありません。

- 対象 ResolutionSnapshot に対して observe phase の再起動を要求する。kernel は
  通常 observe loop と同じ path を使い、completion 後に DriftIndex compute を
  走らせる。
- 手動 re-observe は WAL stage を進めない。`observe` stage の中で observation を
  refresh するだけで、`finalize` 等への遷移を引かない。
- operator は手動 re-observe の結果を internal drift query で確認できる。

手動 re-observe の発火は audit event `operation-intent-recorded` の sub-kind
として記録されます (`eventType: operation-intent-recorded` /
`payload.kind: drift-reobserve`)。

## Drift entry kind

`DriftEntry.kind` は closed enum で、reference drift model
が固定します。代表的な category は以下です。

| kind                        | 意味                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `missing-managed-object`    | DesiredSnapshot 上は present な managed object が observed missing |
| `unexpected-managed-object` | DesiredSnapshot 上は absent だが observed が当該 address を返す    |
| `field-mismatch`            | object は present だが kernel-fixed 比較 field 集合に差分          |
| `stale-secret-projection`   | secret projection が observed 上で expired / rotated 状態          |
| `unmanaged-collision`       | 同名 unmanaged object が observed 上で衝突している                 |
| `lifecycle-class-mismatch`  | declared lifecycle class と observed lifecycle class が不一致      |

新 category 追加には `CONVENTIONS.md` §6 RFC が要ります。

## Invariants

- DriftIndex は DesiredSnapshot を mutate しない。
- DriftIndex の compute は idempotent。同 input で同 output に収束する。
- drift 起因の rollback は activation lifecycle 経由のみ。DesiredSnapshot
  を直接編集する経路は存在しない。
- DriftIndex の `DriftEntry.kind` は internal category enum。`severity` は
  `warning` / `error` の 2 値 closed。
- 手動 re-observe は WAL stage を進めない。observe loop に乗るだけ。

## Related architecture notes

関連 architecture notes:

- `docs/reference/revoke-debt.md` — DriftIndex の compute trigger / 比較方法 /
  RevokeDebt 連動の設計議論
- `docs/reference/architecture/snapshot-model.md` — DesiredSnapshot /
  ObservationSet / ActivationSnapshot の関係と DriftIndex の位置付け
- `docs/reference/architecture/exposure-activation-model.md` — drift annotation
  が ActivationSnapshot を経由して traffic shift gate に効く経路の議論

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [Lifecycle Phases](./lifecycle-phases.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Audit Events](./audit-events.md)
