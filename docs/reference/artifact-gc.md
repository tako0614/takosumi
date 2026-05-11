# Artifact GC and Activation History

> Stability: stable Audience: operator, kernel-implementer See also:
> [DataAsset Kinds](/reference/artifact-kinds),
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Kernel HTTP API](/reference/kernel-http-api), [CLI](/reference/cli),
> [Quota and Rate Limit](/reference/quota-rate-limit),
> [Revoke Debt](/reference/revoke-debt)

This reference defines the v1 artifact garbage-collection contract and the
ActivationSnapshot history export surface. Both surfaces share a
mark-and-traverse pattern over the persistent record set declared in
[Storage Schema](/reference/storage-schema).

## Artifact GC scope

GC operates on **DataAsset** records (see
[DataAsset Kinds](/reference/artifact-kinds)) and their backing object bytes.
Every DataAsset belongs to one of three reachability classes determined at GC
time:

- **Generated-object reachable**: a DataAsset is referenced from an object whose
  binding is live in the most recent ResolutionSnapshot of any active
  Deployment. The reference may be direct (Manifest `artifact:` field) or
  indirect (output that resolves to the artifact's content hash).
- **Snapshot reachable**: a DataAsset is referenced from a retained
  ResolutionSnapshot or ActivationSnapshot, even if no live binding exists
  today. Snapshot retention windows are operator-controlled through the audit
  retention regime.
- **Unreferenced**: neither class above. Unreferenced DataAssets become
  candidates for sweep after the grace window.

The reachability check is conservative: when a DataAsset is referenced by _any_
retained snapshot, even one that is no longer the latest, the DataAsset is kept.
This avoids GC-induced reference breakage during rollback and during
ActivationSnapshot history queries.

## GC process

GC runs as a **mark-then-sweep** sequence with a grace window between the two
phases.

### Mark phase

The mark phase walks live references from a closed root set:

1. Every Deployment's most recent ResolutionSnapshot.
2. Every retained ResolutionSnapshot within the audit retention window.
3. Every retained ActivationSnapshot within the audit retention window.
4. Every RevokeDebt row whose `status` is `open` or `operator-action-required`
   (see [RevokeDebt Model](/reference/revoke-debt)).

A DataAsset reachable from any root is marked `live`. A DataAsset reachable from
no root is marked `unreferenced`. Marks are written to the partition declared in
[Storage Schema](/reference/storage-schema) and survive process restart; the
next phase reads them back.

The mark phase progresses by **cursor**: each root class advances a cursor
through its record set so a crash mid-mark resumes from the last committed
cursor. The cursor is monotonic on `eventId` to align with audit ordering.

### Sweep phase

The sweep phase deletes a DataAsset only after it has been marked `unreferenced`
for at least the **grace window**:

```text
sweep eligibility = markedAt + graceWindow <= now
```

The grace window is operator-controlled via `TAKOSUMI_ARTIFACT_GC_GRACE_DAYS`
(default `7`). A DataAsset that re-acquires a live reference during the grace
window is re-marked `live` and skipped on this sweep cycle.

Rationale: 7 日は典型的な weekly operator review cycle に整合し、誤って
unreferenced 化された DataAsset を operator が手動で keep に戻せる猶予を provide
する。短すぎると operator vacation / on-call rotation 中の事故 recovery
余地が無くなり、長すぎると storage pressure 緩和の reactivity を損なう。

Sweep emits one `artifact-gc-completed` audit event per cycle (see
[Audit Events](/reference/audit-events)). The payload reports `markedLive`,
`markedUnreferenced`, `swept`, `bytesReclaimed`, and the cursor head.

## GC trigger

Three triggers produce a GC cycle:

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

Multiple triggers within a single mark cycle coalesce: a queued cycle absorbs
subsequent enqueues until it completes. The `artifact-gc-completed` audit event
records the union of triggers that caused the cycle.

## Atomicity

GC is **idempotent and crash-safe**:

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

ActivationSnapshot history is the operator-facing audit of activation state per
Space (see [Storage Schema](/reference/storage-schema) and
[Audit Events](/reference/audit-events) `activation-snapshot-created` /
`group-head-moved`). The export surface produces a queryable, resumable
projection of that history for billing pipelines, compliance dashboards, and
external analytics.

### Format

The export is an ordered stream of records keyed by **monotonic event id** and
**time bucket**:

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
- `space-export-share-activated`
- `space-export-share-revoked`

The bucket key is fixed at one hour for the v1 export. Operators that need finer
granularity consume the underlying audit events directly.

### Resume cursor

The spec-reserved activation-history export endpoint accepts an `afterEventId`
cursor and returns results strictly after that id. Pagination is forward-only
and monotonic; clients persist the last-seen `eventId` and resume from there:

```http
GET /api/internal/v1/spaces/:spaceId/activation-history?afterEventId=01HZ...&limit=500
```

The response includes `nextEventId` (the highest id in the page) and `hasMore`.
A response with `hasMore: false` is consistent with the audit log up to the
kernel's serialization clock at response time; later events appear on the next
call.

### Filters

The spec-reserved endpoint accepts:

| Filter       | Notes                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| `spaceId`    | Path-bound; no cross-Space export from this surface.                                   |
| `groupId`    | Optional; restricts results to a GroupHead.                                            |
| `from`, `to` | RFC 3339; restricts the returned bucket range. Inclusive on `from`, exclusive on `to`. |
| `kind`       | Repeatable; filters to the listed kinds.                                               |

Filter combination is conjunctive. The `afterEventId` cursor is applied after
filters: `afterEventId` does not skip filtered-out events, it advances over the
underlying event id space.

### Edge cases

- **Group transition**: a GroupHead pointer move emits exactly one
  `group-head-moved` event with the prior and new ActivationSnapshot ids. A
  canary that ramps through several stages emits one event per stage; operators
  that need a single "rollout completed" signal derive it by joining consecutive
  `group-head-moved` events on `groupId`.
- **Rollback**: a recovery-mode rollback emits one `group-head-rolled-back`
  event followed by zero or more `group-head-moved` events for re-pinning. The
  `payload.cause` field carries the `recoveryMode` discriminator so analytics
  distinguish rollback from forward shift.
- **SpaceExportShare lifecycle**: reserved / future RFC. Current v1 artifact GC
  does not root assets through cross-Space share records.

### Audit linkage

Every history record corresponds 1:1 to an audit event in the closed event-type
enum (see [Audit Events](/reference/audit-events)). The history export does not
invent new events; it projects existing events with a stable schema and a stable
cursor. This keeps the audit log the single source of truth and lets operators
reconcile history exports against the audit hash chain offline.

## Audit events

The two surfaces emit:

- `artifact-gc-completed` — issued at the end of every GC cycle. Payload reports
  cursor, mark counts, sweep counts, bytes reclaimed, triggers, and run
  duration.
- `activation-history-exported` — issued for each successful export fetch above
  a configurable result-size floor
  (`TAKOSUMI_ACTIVATION_HISTORY_AUDIT_MIN_RESULTS`, default `0`, meaning every
  fetch). Payload reports actor, filter parameters, `afterEventId`,
  `nextEventId`, and result count.

Both events ride the standard envelope and the per-Space hash chain. GC's
`spaceId` is `null` (kernel-global) when the cycle covers all Spaces and the
owning Space id when an operator scopes the cycle.

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
