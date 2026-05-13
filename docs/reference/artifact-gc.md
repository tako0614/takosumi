# Artifact GC and Activation History

> このページでわかること: artifact の GC ポリシーと activation history
> の保持ルール。

本リファレンスは v1 artifact ガベージコレクション contract と ActivationSnapshot
history export surface を定義する。両 surface は
[Storage Schema](/reference/storage-schema) で宣言される永続レコード集合に対する
mark-and-traverse パターンを共有する。

## Artifact GC scope

GC は **DataAsset** レコード ([DataAsset Kinds](/reference/artifact-kinds) 参照)
とその裏付け object bytes に対して動作する。各 DataAsset は GC 時に次の 3 つの
到達性クラスのいずれかに割り当てられる。

- **Generated-object reachable**: アクティブな Deployment の最新
  ResolutionSnapshot で binding が live な object から参照されている
  DataAsset。参照は直接 (Manifest の `artifact:` field) でも間接 (artifact の
  content hash に resolve される出力) でもよい。
- **Snapshot reachable**: たとえ今日 live な binding が無くても、保持されている
  ResolutionSnapshot または ActivationSnapshot から参照されている DataAsset。
  Snapshot の retention window は audit retention regime を通じて operator が
  制御する。
- **Unreferenced**: 上記いずれにも該当しない。Unreferenced な DataAsset は grace
  window を経過すると sweep 候補となる。

到達性チェックは保守的である: 最新でなくとも _いずれかの_ 保持済み snapshot に
参照されていれば DataAsset は保持される。これにより rollback 時や
ActivationSnapshot history クエリ中の GC 起因の参照破損を回避する。

## GC process

GC は **mark-then-sweep** の sequence として実行され、2 つの phase の間に grace
window を持つ。

### Mark phase

mark phase は closed な root 集合から live な参照を辿る。

1. Every Deployment's most recent ResolutionSnapshot.
2. Every retained ResolutionSnapshot within the audit retention window.
3. Every retained ActivationSnapshot within the audit retention window.
4. Every RevokeDebt row whose `status` is `open` or `operator-action-required`
   (see [RevokeDebt Model](/reference/revoke-debt)).

いずれかの root から到達可能な DataAsset は `live` と mark される。どの root
からも到達不能な DataAsset は `unreferenced` と mark される。mark は
[Storage Schema](/reference/storage-schema) で宣言された partition
に書き込まれ、 process 再起動を跨いで保持される。次の phase がそれを読み戻す。

mark phase は **cursor** で進行する: 各 root class はその record 集合を通じて
cursor を進めるので、mark 中にクラッシュしても最後に commit された cursor から
再開する。cursor は audit ordering に合わせて `eventId` で単調である。

### Sweep phase

sweep phase は DataAsset が少なくとも **grace window** の間 `unreferenced` と
mark されている場合に限り削除する。

```text
sweep eligibility = markedAt + graceWindow <= now
```

grace window は `TAKOSUMI_ARTIFACT_GC_GRACE_DAYS` (default `7`) で operator が
制御する。grace window 中に live な参照を再取得した DataAsset は `live` に
re-mark され、今回の sweep cycle ではスキップされる。

Rationale: 7 日は典型的な weekly operator review cycle に整合し、誤って
unreferenced 化された DataAsset を operator が手動で keep に戻せる猶予を provide
する。短すぎると operator vacation / on-call rotation 中の事故 recovery
余地が無くなり、長すぎると storage pressure 緩和の reactivity を損なう。

Sweep は cycle ごとに 1 件の `artifact-gc-completed` audit event を発行する
([Audit Events](/reference/audit-events) 参照)。payload には `markedLive`、
`markedUnreferenced`、`swept`、`bytesReclaimed`、cursor head が含まれる。

## GC trigger

GC cycle を生む trigger は 3 種類。

| Trigger           | Source                                               | Notes                                                                                                                                |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Periodic          | Worker daemon timer                                  | Cadence `TAKOSUMI_ARTIFACT_GC_PERIODIC_HOURS` (default `24`). Off when set to `0`.                                                   |
| Manual            | `takosumi artifact gc` CLI / `POST /v1/artifacts/gc` | Operator-driven. Supports `--dry-run` to mark without sweeping.                                                                      |
| Storage threshold | `artifact-storage-bytes` quota signal                | When kernel-global storage usage crosses `TAKOSUMI_ARTIFACT_GC_PRESSURE_FRACTION` (default `0.85`), a cycle is enqueued out of band. |

Rationale (24h cadence): 24 時間は audit retention の daily aggregation boundary
と整合し、daily 単位で sweep 観測値を比較しやすい。短いと WAL / audit chain
rotation と重なって lock contention が増え、長いと unreferenced 蓄積が storage
pressure trigger を先行させる。

Rationale (0.85 pressure): 0.85 は steady-state における burst write buffer (約
15%) を確保しつつ、out-of-band cycle が完了する前に hard quota fail
を引かない閾値。0.9 以上では cycle 走行中に書き込み backpressure が発生し、0.8
以下では periodic cycle と頻繁に重複してしまう。

単一 mark cycle 内の複数 trigger は合一される: queue 済み cycle は完了するまで
後続の enqueue を吸収する。`artifact-gc-completed` audit event は cycle を起こ
した trigger の和集合を記録する。

## Atomicity

GC は **idempotent でクラッシュ安全** である。

- Mark and sweep cursors are persisted on every batch boundary. A crash
  mid-cycle resumes at the last cursor without double-marking.
- A DataAsset that gains a live reference _during_ a mark cycle is treated
  conservatively. If the new reference appears before the DataAsset is marked,
  the DataAsset is marked `live`. If the new reference appears after the mark,
  the DataAsset is marked `unreferenced` for this cycle but the next cycle
  re-marks it `live` and the sweep phase skips it.
- Sweep deletion is two-step: object-store deletion succeeds first, then the
  DataAsset row transitions to `swept`. A crash between the two steps leaves the
  row in `sweep-pending`; the next cycle finishes the row transition
  idempotently.
- Sweep never deletes a DataAsset whose marker is older than
  `TAKOSUMI_ARTIFACT_GC_MARKER_TTL_HOURS` (default `72`). A stale marker forces
  a re-mark before sweep proceeds, preventing an outdated mark from sweeping a
  now-live DataAsset. Rationale: 72 時間 (3 日) は週末 / 連休にまたがる worker
  pause 後でも marker を信頼して sweep に進める短さと、stale marker を捨てて
  re-mark するコストが許容できる長さの均衡点。grace window (7 日) より短く取り、
  marker 再生成が必ず先行する関係を保つ。

## ActivationSnapshot history export

ActivationSnapshot history は Space 単位の activation 状態を operator 向けに監査
するもの ([Storage Schema](/reference/storage-schema) および
[Audit Events](/reference/audit-events) の `activation-snapshot-created` /
`group-head-moved` を参照)。export surface は billing パイプライン、コンプライ
アンスダッシュボード、外部分析向けにこの history の query 可能 / resume 可能な
projection を生成する。

### Format

export は **monotonic event id** と **time bucket** で key 付けされた順序付き
レコード stream である。

```yaml
ActivationHistoryEvent:
  eventId: 01HZ... # ULID, monotonic per Space
  ts: 2026-04-12T07:43:11.214Z # RFC 3339 UTC
  bucket: 2026-04-12T07:00:00Z/1h # time bucket key
  spaceId: space:tenant-a
  groupId: group:web/main # nullable for Space-level events
  kind: <enum> # see below
  activationSnapshotId: activation:01HZ...
  resolutionSnapshotId: resolution:01HZ...
  payload: { ... }
```

`kind` is a closed enum:

- `activation-snapshot-created`
- `group-head-moved`
- `group-head-rolled-back`

v1 export の bucket key は 1 時間に固定される。より細かい粒度が必要な operator
は基となる audit event を直接 consume する。

### Resume cursor

cursor を受け取り、その id より厳密に後ろの結果を返す。pagination は forward
のみで monotonic。client は最後に見た `eventId` を永続化してそこから resume
する。

```http
GET /api/internal/v1/spaces/:spaceId/activation-history?afterEventId=01HZ...&limit=500
```

response には `nextEventId` (このページ内の最大 id) と `hasMore` が含まれる。
`hasMore: false` の response は応答時点の kernel serialization clock までの
audit log と整合する。それ以降の event は次の呼び出しで現れる。

### Filters

| Filter       | Notes                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| `spaceId`    | Path-bound; no cross-Space export from this surface.                                   |
| `groupId`    | Optional; restricts results to a GroupHead.                                            |
| `from`, `to` | RFC 3339; restricts the returned bucket range. Inclusive on `from`, exclusive on `to`. |
| `kind`       | Repeatable; filters to the listed kinds.                                               |

Filter の組み合わせは論理積。`afterEventId` cursor は filter の後に適用される:
`afterEventId` は filter 除外された event をスキップするのではなく、基底の event
id 空間上を進む。

### Edge cases

- **Group transition**: a GroupHead pointer move emits exactly one
  `group-head-moved` event with the prior and new ActivationSnapshot ids. A
  canary that ramps through several stages emits one event per stage; operators
  that need a single "rollout completed" signal derive it by joining consecutive
  `group-head-moved` events on `groupId`.
- **Rollback**: a recovery-mode rollback emits one `group-head-rolled-back`
  event followed by zero or more `group-head-moved` events for re-pinning. The
  `payload.cause` field carries the `recoveryMode` discriminator so analytics
  distinguish rollback from forward shift. does not root assets through
  cross-Space share records.

### Audit linkage

すべての history record は closed な event-type enum の audit event と 1:1 に
対応する ([Audit Events](/reference/audit-events) 参照)。history export は新規
event を発明しない。既存の event を安定 schema と安定 cursor で projection
する。 これにより audit log を唯一の真実とし、operator が history export を
audit hash chain と offline で照合できるようにする。

## Audit events

2 つの surface は次を発行する。

- `artifact-gc-completed` — issued at the end of every GC cycle. Payload reports
  cursor, mark counts, sweep counts, bytes reclaimed, triggers, and run
  duration.
- `activation-history-exported` — issued for each successful export fetch above
  a configurable result-size floor
  (`TAKOSUMI_ACTIVATION_HISTORY_AUDIT_MIN_RESULTS`, default `0`, meaning every
  fetch). Payload reports actor, filter parameters, `afterEventId`,
  `nextEventId`, and result count.

どちらの event も標準 envelope と per-Space hash chain に乗る。GC の `spaceId`
は cycle が全 Space をカバーする場合 `null` (kernel-global)、operator が cycle
を scope したときは所有 Space の id となる。

## Related architecture notes

- `docs/reference/architecture/data-asset-model.md` — DataAsset reachability
  model and the rationale for the conservative mark phase.
- `docs/reference/architecture/snapshot-model.md` — snapshot retention semantics
  that drive the snapshot-reachable mark class.
- `docs/reference/architecture/exposure-activation-model.md` —
  ActivationSnapshot shape that grounds the activation history projection.
- `docs/reference/architecture/observation-drift-revokedebt-model.md` —
  RevokeDebt rows as a GC root, ensuring debt-pinned material is not swept while
  cleanup is in flight.

## 関連ページ

- [DataAsset Kinds](/reference/artifact-kinds)
- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Kernel HTTP API](/reference/kernel-http-api)
- [CLI](/reference/cli)
- [Quota and Rate Limit](/reference/quota-rate-limit)
- [Revoke Debt](/reference/revoke-debt)
