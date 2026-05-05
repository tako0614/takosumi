# Observation Retention

> Stability: stable Audience: operator, kernel-implementer See also:
> [Lifecycle Protocol](/reference/lifecycle),
> [Audit Events](/reference/audit-events),
> [Journal Compaction](/reference/journal-compaction),
> [RevokeDebt Model](/reference/revoke-debt),
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [Compliance Retention](/reference/compliance-retention)

Takosumi v1 で kernel が保持する observed state には複数の retention 層が
あり、それぞれ目的・寿命・operator 制御点が異なる。本 reference は
ObservationSet / ObservationHistory / OperationJournal / AuditLog の 4 層と、
ExportDeclaration freshness の propagation 規則を closed semantics で 定義する。

## 4-layer retention model

| 層                   | 性質                         | 既定保持                    | operator 制御               |
| -------------------- | ---------------------------- | --------------------------- | --------------------------- |
| `ObservationSet`     | 現在状態 (current state)     | latest 1 entry per Space    | enable/disable は不可       |
| `ObservationHistory` | 任意の時系列 snapshot        | 0 (opt-in 必須)             | per-Space に enable/disable |
| `OperationJournal`   | recovery-critical な操作履歴 | RevokeDebt 解消まで削除禁止 | compaction policy           |
| `AuditLog`           | compliance-driven な決定記録 | regime ごとに固定 minimum   | regime 選択                 |

各層は独立に compact / archive / drop される。下位層 (ObservationSet /
ObservationHistory) を消しても上位層 (Journal / Audit) は維持される。

### `ObservationSet`

- **保持件数**: 各 Space で **最新 1 entry** のみ。新 ObservationSet は 既存
  entry を supersede する (in-place replace 相当)。
- **更新タイミング**: observe phase が runtime-agent describe を取り終え、
  ExportDeclaration freshness を annotate した時点。
- **TTL**: kernel constant ではない。次の ObservationSet が書かれるまで
  保持されるだけで、明示的 expiry はかけない。
- **読者**: resolution / planning / approval invalidation の input。
- **operator 制御**: disable できない。kernel が動く以上、observe loop は
  ObservationSet を更新し続ける。

### `ObservationHistory`

- **保持件数**: opt-in。default は **disable** で、enable された Space のみ
  ObservationSet 更新時に history に append される。
- **enable 単位**: per-Space。global default は無く、operator が Space ごと
  に明示 enable する。
- **authoritative ではない**: history は resolution / planning / approval
  invalidation の input には **使われない**。observability / forensics 用。
- **disable 後の挙動**: history を disable しても、過去 entry は operator が
  drop するまで残る。新 ObservationSet は append されなくなる。
- **OperationJournal / RevokeDebt との関係**: history を disable しても Journal
  / RevokeDebt は **消えない**。recovery 半径は維持される。

### `OperationJournal`

- **削除制約**: 関連 RevokeDebt の status が non-terminal (`open` /
  `compensating`) の間は削除禁止。compaction も対象 entry を保持する。
- **compaction**: [Journal Compaction](/reference/journal-compaction) の規則
  に従う。terminal RevokeDebt と紐づく entry のみ compact 候補。

### `AuditLog`

- **retention**: compliance regime ごとに minimum が固定される
  ([Compliance Retention](/reference/compliance-retention))。
- **削除**: regime minimum を超え、archive sink delivery が確認された entry のみ
  primary store から drop 可。

## ObservationHistory opt-in semantics

### Enable / disable

operator は per-Space に history を toggle する。

- enable: 次の ObservationSet 書き込みから append が始まる。既存 history
  は変更されない。
- disable: 以後の ObservationSet は history に append されない。
- toggle 自体は audit event として記録される (`observation-history-enabled` /
  `observation-history-disabled`)。

### Authoritative ではない

history は **read-only な observability source** として扱う。

- resolution は ObservationSet (latest only) を参照する。
- approval invalidation の external freshness change trigger は ObservationSet
  の freshness 遷移を見る。history を遡って trigger を 生成することはない。
- planning も history を input にしない。

### Storage / drop

history entry の drop は operator policy。kernel は default で history を trim
せず、operator が age / count cap を policy で指定する。 compliance 対象外なので
regime 制約は受けない。

## Freshness propagation

ExportDeclaration / SpaceExportShare の freshness は kernel が観測し、
ObservationSet に annotation として埋まる。

### 4-state freshness

freshness state は [SpaceExportShare](/reference/space-export-share) の share
lifecycle (`draft | active | refresh-required | stale | revoked`)
と整合し、ObservationSet annotation 上で `refresh-required` と `stale` を別
state として保持する。

| state              | 意味                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `fresh`            | refresh window 内、external system も同期済み                                                     |
| `refresh-required` | refresh window approach。consumer 側 resolution は依然成功するが warning 相当の Risk を emit する |
| `stale`            | refresh window expired / refresh attempt 失敗。consumer 側 resolution は fail-closed する         |
| `revoked`          | external system 側で revoke 済み (terminal)                                                       |

`unknown` は kernel が観測未完了の transient marker (起動直後 / runtime-agent
unreachable) で、上記 4-state が確定するまでの中間表現 として ObservationSet
に書く。state 遷移は ObservationSet 更新の単位で 起き、history が enable なら
history にも記録される。

### Risk への connection

- `refresh-required` 検出は warning 相当の Risk を emit する (resolution は
  blocking しない)。
- `stale` 検出は plan で error 相当の `stale-export` Risk を発火する
  ([Risk Taxonomy](/reference/risk-taxonomy))。
- `revoked` 検出は `revoked-export` Risk を発火する。
- 観測未完了 (`unknown` marker) は plan を blocking しないが、observe loop が
  4-state のいずれかに収束するのを待つ。

### Approval invalidation との関係

freshness state の遷移は approval invalidation trigger の **external freshness
change** (trigger 4) の発火源だが、`refresh-required` と `stale` は別 bucket
として扱われる。

- `fresh → refresh-required`: warning レベル。ObservationSet には記録 されるが
  trigger 4 は発火させない。consumer 側 plan は warning Risk と共に依然 consume
  可能で、approval は `approved` のまま保持される。
- `fresh → stale` または `* → revoked`: trigger 4 の発火条件。 ObservationSet
  が遷移を記録した瞬間、当該 export を消費する binding subset の approval が
  `invalidated` に落ちる
  ([Approval Invalidation Triggers — external freshness change](/reference/approval-invalidation#_4-external-freshness-change))。

history が enable / disable のどちらでも、この trigger 経路は同じ。 trigger は
ObservationSet (latest) の遷移で発火するので、history は 不要。

## Observability flow

```
runtime-agent describe
       │
       ▼
observe phase
       │
       ├──► ObservationSet (latest only, authoritative)
       │           │
       │           ├──► resolution / planning input
       │           ├──► approval invalidation trigger
       │           └──► DriftIndex compute base
       │
       └──► ObservationHistory (if enabled, non-authoritative)
                   │
                   └──► operator-only forensics
```

DriftIndex は ObservationSet を base に compute され、 `RevokeDebt` 発火条件の
input となる ([RevokeDebt Model](/reference/revoke-debt))。 history はこの
compute path には参加しない。

## Operator surface

- **status endpoint**: current public `takosumi status` is limited to deployment
  summaries. Per-Space ObservationSet summary belongs to the operator internal
  control plane until a public CLI flag is implemented.
- **history toggle**: observation history enable / disable is an operator-only
  operation. It is not exposed by the current public deploy CLI.
- **history dump**: enable された Space のみ history を operator tooling で
  取り出せる。default disable 時は empty を返す。
- **freshness probe**: ExportDeclaration の freshness は operator internal
  control-plane query で per-export に確認できる。

operator が history を disable した状態で運用する場合でも、
ObservationSet・OperationJournal・AuditLog は kernel が維持するので、 recovery /
compliance / approval invalidation の保証は崩れない。

## Failure modes

| 状況                            | 検出層                   | 復旧                                   |
| ------------------------------- | ------------------------ | -------------------------------------- |
| runtime-agent unreachable       | ObservationSet `unknown` | 接続復旧で次 observe で resolve        |
| ObservationSet 書き込み失敗     | observe loop 再試行      | 自動 retry、backoff                    |
| history append 失敗 (enable 中) | warn log                 | history は best-effort、Journal は維持 |
| freshness annotation 欠落       | 次 observe で補填        | 自動                                   |

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/snapshot-model.md` — snapshot 階層 (Resolution /
  Desired / Observation) の rationale
- `docs/reference/architecture/policy-risk-approval-error-model.md` — freshness
  由来の Risk と approval invalidation の interplay
- `docs/reference/architecture/operator-boundaries.md` — observe phase の
  operator 可視性 と authoritative source の trust 境界
