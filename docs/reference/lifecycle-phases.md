# Lifecycle Phases

> Stability: stable
> Audience: kernel-implementer
> See also: [Closed Enums](/reference/closed-enums), [Lifecycle Protocol](/reference/lifecycle), [Runtime-Agent API](/reference/runtime-agent-api)

The Takosumi v1 lifecycle is a 6-phase closed enum applied per
OperationPlan, paired with a 5-value `LifecycleStatus` closed enum that
describes the steady-state visibility of each managed object on its
backing connector. Both enums are closed; new values require a
`CONVENTIONS.md` §6 RFC.

```text
Phases:           apply | activate | destroy | rollback | recovery | observe
LifecycleStatus:  running | stopped | missing | error | unknown
```

The phase enum drives the WAL stage progression on
`(spaceId, operationPlanDigest, journalEntryId)` keys. The
`LifecycleStatus` enum is reported by runtime-agent describe and by
kernel observe loops; it never appears as input to the apply pipeline.

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

`observe` is long-lived and overlaps with the next intentional `apply`
or `destroy` on the same Space; it does not block them. `rollback` and
`recovery` always re-enter via WAL replay against the last persisted
journal entry.

### `apply`

- **Input snapshot.** DesiredSnapshot from the manifest plus the prior
  `ResolutionSnapshot` (if one exists for the Space).
- **Output snapshot.** New `ResolutionSnapshot` and its bound
  `OperationPlan`.
- **Journal cursor.** Allocates a fresh `journalEntryId` per operation;
  records `(spaceId, operationPlanDigest, journalEntryId)`.
- **WAL stages touched.** `prepare` -> `pre-commit` -> `commit`.
- **Failure behavior.** Failures inside `prepare` discard the new plan
  with no side effects. Failures inside `pre-commit` run the operation's
  registered compensate hook on the same WAL entry. Failures inside
  `commit` mark the entry as `commit-failed`; recovery determines
  resume vs. compensate.
- **Blocking semantics.** Holds the
  `(spaceId, operationPlanDigest)` cross-process lock for its full
  duration. Other intentional phases on the same Space queue.
- **Typical duration.** Seconds to single-digit minutes for typical
  manifests; bounded by connector apply latency for OCI image pulls
  and Transform-bearing plans.

### `activate`

- **Input snapshot.** `ResolutionSnapshot` produced by `apply`.
- **Output snapshot.** Activation-side effects on connectors;
  Exposure health initialized to `unknown`. No new
  `ResolutionSnapshot` is produced.
- **Journal cursor.** Continues the apply phase's journal entries
  through their `commit` -> `post-commit` transitions.
- **WAL stages touched.** `commit` -> `post-commit`.
- **Failure behavior.** A `post-commit` failure does not roll the
  effect back; it opens a `post-commit-failed` annotation that the
  observe loop reconciles, and may emit a `RevokeDebt` of reason
  `activation-rollback` if the operator chose `compensate` recovery.
- **Blocking semantics.** Same lock as the originating `apply`.
- **Typical duration.** Sub-minute; dominated by connector traffic-flip
  / DNS / readiness propagation.

### `destroy`

- **Input snapshot.** Current `ResolutionSnapshot` for the Space.
- **Output snapshot.** A `ResolutionSnapshot` with managed and
  generated lifecycle-class objects removed; external, operator, and
  imported objects untouched.
- **Journal cursor.** Allocates new `journalEntryId`s under the
  destroy plan digest.
- **WAL stages touched.** `pre-commit` -> `commit` -> `finalize`.
- **Failure behavior.** A `commit` failure leaves objects in
  partially-deleted state; recovery may resume `commit` (idempotent)
  or compensate to the pre-destroy snapshot. `finalize` errors emit
  `RevokeDebt` of reason `external-revoke` when an external connector
  refuses deletion.
- **Blocking semantics.** Same lock; mutually exclusive with `apply`.
- **Typical duration.** Comparable to `apply`; can be longer when
  external resource deletion has slow-side-effect semantics.

### `rollback`

- **Input snapshot.** The `ResolutionSnapshot` immediately prior to the
  one being rolled out of.
- **Output snapshot.** That prior `ResolutionSnapshot` re-materialized
  on the connectors.
- **Journal cursor.** New `journalEntryId`s; the rollback plan has its
  own `operationPlanDigest`.
- **WAL stages touched.** `pre-commit` (compensate replay) ->
  `commit` -> `abort`.
- **Failure behavior.** If compensate cannot be applied for an entry,
  the rollback enters `abort` and emits a `RevokeDebt` of reason
  `activation-rollback`.
- **Blocking semantics.** Same lock as forward phases.
- **Typical duration.** Similar to the original `apply`; bounded by
  the slowest compensate hook.

### `recovery`

- **Input snapshot.** The persisted WAL state plus the most recent
  `ResolutionSnapshot` for the Space.
- **Output snapshot.** Depends on the recovery mode (`normal` /
  `continue` / `compensate` / `inspect`); see
  [Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes).
- **Journal cursor.** Resumes from the next stage after the last
  persisted entry; never allocates a new `journalEntryId` for an
  already-recorded operation.
- **WAL stages touched.** Whichever stages remain after the resume
  point.
- **Failure behavior.** Mode-specific. `inspect` never has side
  effects. `compensate` may emit `RevokeDebt`.
- **Blocking semantics.** Acquires the same cross-process lock as the
  phase it is resuming.
- **Typical duration.** Driven by the work the original phase had
  remaining.

### `observe`

- **Input snapshot.** Live runtime-agent describe results plus the
  current `ResolutionSnapshot`.
- **Output snapshot.** Exposure health transitions
  (`unknown` -> `observing` -> `healthy` / `degraded` / `unhealthy`);
  ObservationSet entries; candidate `RevokeDebt` entries when drift
  or external revoke is detected.
- **Journal cursor.** Reuses the long-lived observe entry per Space;
  observe never allocates new operation plan digests.
- **WAL stages touched.** `observe` (long-lived; never terminal).
- **Failure behavior.** Observe failures are non-blocking; they raise
  freshness annotations but never compensate effects.
- **Blocking semantics.** Does not hold the apply lock; runs
  concurrently with steady-state traffic.
- **Typical duration.** Continuous.

## `LifecycleStatus` enum

The 5-value `LifecycleStatus` enum is what runtime-agent reports for a
managed object on its backing connector. It is observed state, not a
control plane phase.

```text
running | stopped | missing | error | unknown
```

| Value      | Meaning                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `running`  | Object exists and is in the connector's "live" state per the shape's contract.                                |
| `stopped`  | Object exists but is intentionally not running (e.g. paused workers, drained gateway).                         |
| `missing`  | Object is absent from the connector view; either never applied or externally deleted.                          |
| `error`    | Object exists but the connector reports a fault that prevents normal operation.                                |
| `unknown`  | Connector did not respond, returned an unrecognized state, or the runtime-agent has not described it yet.      |

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

`verify` is a read-only trigger that reports `connector_not_found` or
`connector_failed` against the connector itself; it never updates the
`LifecycleStatus` of a managed object.

### Reporting conditions

The runtime-agent reports `LifecycleStatus` on every describe round
and on the lifecycle response of `apply` / `destroy`. It is required
to:

- Return `running` only after the connector confirms the object is
  in its live state per the shape's contract (not merely accepted).
- Return `unknown` rather than guess when the connector is
  unreachable or returns an unrecognized state.
- Return `missing` when the connector has authoritative knowledge
  that the object is absent, not when the connector is silent.
- Return `error` only when the connector reports an explicit fault,
  with the fault detail propagated through the describe envelope.

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/execution-lifecycle.md` — phase 数を 6 に絞った理由と
  observe / recovery を独立 phase として残す decision
- `docs/design/operation-plan-write-ahead-journal-model.md` — phase と
  WAL stage の対応関係、idempotency tuple の設計
- `docs/design/runtime-agent-lifecycle.md` — `LifecycleStatus` を 5
  値に閉じる根拠と describe 報告 contract
