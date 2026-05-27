# Observation の保持 {#observation-retention}

## 4 層 retention モデル {#_4-layer-retention-model}

| 層                   | 性質                         | 既定保持                        | operator 制御               |
| -------------------- | ---------------------------- | ------------------------------- | --------------------------- |
| `ObservationState`   | 現在状態 (current state)     | latest 1 entry per Space        | enable/disable は不可       |
| `ObservationHistory` | 任意の時系列 snapshot        | 0 (opt-in 必須)                 | per-Space に enable/disable |
| `OperationJournal`   | recovery-critical な操作履歴 | CleanupBacklog 解消まで削除禁止 | compaction policy           |
| `AuditLog`           | compliance-driven な決定記録 | regime ごとに固定 minimum       | regime 選択                 |

各層は独立に compact / archive / drop される。下位層 (ObservationState / ObservationHistory) を消しても上位層 (Journal / Audit) は維持される。

### `ObservationState`

- **保持件数**: 各 Space で **最新 1 entry** のみ。新 ObservationState は既存 entry を supersede する (in-place replace 相当)。
- **更新タイミング**: observe phase が runtime-agent describe を取り終え、platform service snapshot freshness を annotate した時点。
- **TTL**: 次の ObservationState が書かれるまで保持する。明示的 expiry は operator policy で扱う。
- **読者**: resolution / planning / approval invalidation の input。
- **operator 制御**: disable できない。kernel が動く以上、observe loop は ObservationState を更新し続ける。

### `ObservationHistory`

- **保持件数**: opt-in。default は **disable** で、enable された Space のみ ObservationState 更新時に history に append される。
- **enable 単位**: per-Space。global default は無く、operator が Space ごとに明示 enable する。
- **用途**: history は observability / forensics 用。resolution / planning / approval invalidation は latest ObservationState を読む。
- **disable 後の挙動**: history を disable しても、過去 entry は operator が drop するまで残る。新 ObservationState は append されなくなる。
- **OperationJournal / CleanupBacklog との関係**: history を disable しても Journal / CleanupBacklog は **消えない**。recovery 半径は維持される。

### `OperationJournal`

- **削除制約**: 関連 CleanupBacklog の status が non-terminal (`open` / `compensating`) の間は削除禁止。compaction も対象 entry を保持する。
- **compaction**: [Journal Compaction](./journal-compaction.md) の規則に従う。terminal CleanupBacklog と紐づく entry のみ compact 候補。

### `AuditLog`

- **retention**: compliance regime ごとに minimum が固定される (operator policy)。
- **削除**: regime minimum を超え、archive sink delivery が確認された entry のみ primary store から drop 可。

## ObservationHistory の opt-in semantics {#observationhistory-opt-in-semantics}

### 有効化 / 無効化 {#enable--disable}

operator は per-Space に history を toggle する。

- enable: 次の ObservationState 書き込みから append が始まる。既存 history は変更されない。
- disable: 以後の ObservationState は history に append されない。
- toggle 自体は audit event として記録される (`observation-history-enabled` / `observation-history-disabled`)。

### Read-only history

history は **read-only な observability source** として扱う。

- resolution は ObservationState (latest only) を参照する。
- approval invalidation の external freshness change trigger は ObservationState の freshness 遷移を見る。trigger 生成は latest state を入力にする。
- planning も latest state を入力にする。

### ストレージ / 破棄 {#storage--drop}

history entry の drop は operator policy。kernel は default で history を trim せず、operator が age / count cap を policy で指定する。 compliance 対象外なので regime 制約は受けない。

## Freshness の伝播 {#freshness-propagation}

operator が管理する platform service snapshot の freshness は Takosumi が観測し、ObservationState entry として記録する。

### 4 状態の freshness {#_4-state-freshness}

freshness state は ObservationState annotation 上で `refresh-required` と `stale` を区別する。

| state              | 意味                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `fresh`            | refresh window 内、external system も同期済み                                                     |
| `refresh-required` | refresh window approach。consumer 側 resolution は依然成功するが warning 相当の Risk を emit する |
| `stale`            | refresh window expired / refresh attempt 失敗。consumer 側 resolution は fail-closed する         |
| `revoked`          | external system 側で revoke 済み (terminal)                                                       |

`unknown` は Takosumi が観測未完了の transient marker (起動直後 / runtime-agent unreachable) で、上記 4-state が確定するまでの中間表現として ObservationState に書く。state 遷移は ObservationState 更新の単位で起き、history が enable なら history にも記録される。

### Risk への接続 {#risk-への-connection}

- `refresh-required` 検出は warning 相当の Risk を emit する (resolution は blocking しない)。
- `stale` 検出は plan で error 相当の `stale-publication` Risk を発火する。risk name は historical stable id で、current prose では stale platform service snapshot を指す ([Risk Taxonomy](./risk-taxonomy.md))。
- `revoked` 検出は `revoked-publication` Risk を発火する。risk name は historical stable id で、current prose では revoked platform service snapshot を指す。
- 観測未完了 (`unknown` marker) は plan を blocking しないが、observe loop が 4-state のいずれかに収束するのを待つ。

### Approval invalidation との関係 {#approval-invalidation-relationship}

freshness state の遷移は approval invalidation trigger の **external freshness change** (trigger 4) の発火源だが、`refresh-required` と `stale` は別 bucket として扱われる。

- `fresh → refresh-required`: warning レベル。ObservationState には記録されるが trigger 4 は発火させない。consumer 側 plan は warning Risk と共に依然 consume 可能で、approval は `approved` のまま保持される。
- `fresh → stale` または `* → revoked`: trigger 4 の発火条件。 ObservationState が遷移を記録した瞬間、当該 platform service path / snapshot を消費する binding subset の approval が `invalidated` に落ちる ([Approval Invalidation Triggers — external freshness change](./approval-invalidation.md#4-external-freshness-change))。

history の enable / disable によらずこの trigger 経路は同じ。trigger は ObservationState (latest) の遷移で発火する。

## Observability フロー {#observability-flow}

```
runtime-agent describe
       │
       ▼
observe phase
       │
       ├──► ObservationState (latest only, authoritative)
       │           │
       │           ├──► resolution / planning input
       │           ├──► approval invalidation trigger
       │           └──► DriftIndex compute base
       │
       └──► ObservationHistory (if enabled, non-authoritative)
                   │
                   └──► operator-only forensics
```

DriftIndex は ObservationState を base に compute され、 `CleanupBacklog` 発火条件の input となる ([CleanupBacklog Model](./revoke-debt.md))。 history はこの compute path には参加しない。

## オペレーター surface {#operator-surface}

- **status endpoint**: Deployment と ObservationState のサマリーは、public CLI フラグが実装されるまで operator 内部の control plane に属する。
- **history toggle**: observation history の有効化・無効化は operator 専用操作であり、public installer CLI には公開されない。
- **history dump**: enable された Space のみ history を operator tooling で取り出せる。default disable 時は empty を返す。
- **freshness probe**: platform service snapshot の freshness は operator internal control-plane query で service path ごとに確認できる。

operator が history を disable した状態で運用する場合でも、 ObservationState・OperationJournal・AuditLog は Takosumi が維持するので、 recovery / compliance / approval invalidation の保証は崩れない。

## 失敗モード {#failure-modes}

| 状況                            | 検出層                     | 復旧                                   |
| ------------------------------- | -------------------------- | -------------------------------------- |
| runtime-agent unreachable       | ObservationState `unknown` | 接続復旧で次 observe で resolve        |
| ObservationState 書き込み失敗   | observe loop 再試行        | 自動 retry、backoff                    |
| history append 失敗 (enable 中) | warn log                   | history は best-effort、Journal は維持 |
| freshness annotation 欠落       | 次 observe で補填          | 自動                                   |

## 関連アーキテクチャ {#related-architecture-notes}

関連 architecture notes:

- `docs/reference/architecture/snapshot-model.md` — snapshot 階層 (Resolution / Desired / Observation) の rationale
- `docs/reference/architecture/approval-model.md` — freshness 由来の Risk と approval invalidation の interplay
- `docs/reference/architecture/operator-boundaries.md` — observe phase の operator 可視性と authoritative source の trust 境界

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [Audit Events](./audit-events.md)
- [Journal Compaction](./journal-compaction.md)
- [CleanupBacklog Model](./revoke-debt.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
