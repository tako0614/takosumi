# Journal Compaction

> Stability: stable Audience: kernel-implementer, operator See also:
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Lifecycle Protocol](/reference/lifecycle)

The WriteAheadOperationJournal grows monotonically as deploy operations transit
the WAL stages. Without compaction the journal would grow without bound, replay
would slow with every additional deploy, and storage cost would diverge from the
size of the live state. This reference defines the compaction triggers, the
retention rules that protect replay correctness, the snapshotization step that
converts compacted ranges into a base snapshot, and the operator controls
available for tuning compaction frequency.

Compaction is independent from audit log retention; see
[Audit Events](/reference/audit-events) for the regime-driven retention rules
that govern audit storage.

## Compaction triggers

A compaction pass starts when any of the following conditions hold. The kernel
evaluates the conditions on a periodic timer and opportunistically at the end of
any deploy.

- Operation-completed thresholds: the count of `operation-completed` entries
  since the last compaction exceeds `TAKOSUMI_JOURNAL_COMPACTION_OP_THRESHOLD`
  (default `1024`).
- Storage size threshold: the on-disk size of the journal partition exceeds
  `TAKOSUMI_JOURNAL_COMPACTION_SIZE_THRESHOLD_MB` (default `512`).
- Age threshold: the oldest non-compacted journal entry is older than
  `TAKOSUMI_JOURNAL_COMPACTION_MAX_AGE_HOURS` (default `168`).
- Manual operator instruction through internal operator tooling or the
  equivalent kernel HTTP API endpoint.

Triggers are OR-combined. The first condition to fire wins; only one compaction
pass runs against a journal at a time. Concurrent triggers are coalesced.

## Retention rules

A JournalEntry is retained when any of the following conditions hold. An entry
that satisfies none of these conditions is eligible for compaction.

- Active generated objects: the entry's `generatedObjectIds` include any object
  that is part of the current ActivationSnapshot.
- Unresolved compensation: the entry belongs to an operation whose compensation
  chain has not reached `compensation-completed`.
- Unresolved revoke debt: the entry references an objectId that has an open
  RevokeDebt with `status` other than `cleared`.
- Current activation support: the entry is required to reconstruct the current
  ActivationSnapshot from the latest base snapshot.
- Approval-bound: the entry references an Approval whose status is `issued` or
  `consumed` and whose audit retention window has not elapsed.
- Operator hold: an operator has placed an explicit hold on the journal range.

An entry that satisfies any of these conditions is kept verbatim; compaction
does not summarize, redact, or rewrite a kept entry.

## Snapshotization

A compaction pass that drops a contiguous prefix of journal entries must record
the dropped range as the base of a new ResolutionSnapshot / DesiredSnapshot
pair.

- The base snapshot pair is computed by folding the dropped entries against the
  previous base snapshot. The pair carries the same immutability rules as any
  other snapshot in [Storage Schema](/reference/storage-schema).
- After snapshotization, replay starts from the new base and reads only the
  post-base journal tail. Replay correctness is preserved because the base
  snapshot encodes every effect that compaction removed.
- The previous base snapshot remains addressable until no ActivationSnapshot,
  DriftIndex, or ObservationSet refers to it. Garbage collection of superseded
  base snapshots is a separate pass that runs after audit retention windows
  clear.
- The snapshotization step writes a single audit event under the
  `catalog-release-rotated` envelope to record the new base snapshot digest
  pair.

## Atomicity

Compaction must be crash-safe. A crash mid-pass must not lose journal entries
and must not leave the base snapshot pair in a partially written state.

- The kernel writes the new base snapshot pair before truncating the compacted
  prefix. The two writes are coupled by a manifest that names both the new base
  and the truncated prefix range.
- The journal cursor that names the active base snapshot pair is advanced
  atomically: readers either see the previous base with the full journal, or the
  new base with the truncated tail, never an intermediate state.
- A crash before the cursor advance leaves the pre-compaction state intact; a
  restart re-runs the compaction pass.
- A crash after the cursor advance but before the prefix truncation completes
  leaves orphan compacted entries; the next compaction pass recognizes the
  orphan range by its position before the active cursor and reclaims it.

The journal cursor itself is part of the kernel's recovery state and is durable
across restarts.

## Relationship with retention regimes

Audit log retention regimes (`default`, `pci-dss`, `hipaa`, `sox`, `regulated`)
constrain the AuditLog event store, not the journal. Journal compaction operates
on its own retention rules and timer.

- An AuditLog event referencing a journal entry survives compaction: the audit
  event records the operation outcome, not the journal entry bytes.
- A regime that forces longer audit retention does not extend journal retention.
  The JournalEntry can be compacted while the audit event remains live.
- A regime that requires journal-grade replay (e.g. for forensic reconstruction)
  configures `TAKOSUMI_JOURNAL_COMPACTION_OP_THRESHOLD` and friends to hold
  journal entries longer; the regime itself does not alter compaction semantics.

See [Audit Events](/reference/audit-events) for the regime taxonomy and
event-level retention rules.

## Operator controls

Operators tune compaction frequency through env vars on the kernel host:

- `TAKOSUMI_JOURNAL_COMPACTION_OP_THRESHOLD` — operation-completed count that
  triggers a pass. Default `1024`. Set to `0` to disable the operation-count
  trigger.
- `TAKOSUMI_JOURNAL_COMPACTION_SIZE_THRESHOLD_MB` — on-disk size threshold in
  mebibytes. Default `512`. Set to `0` to disable the size trigger.
- `TAKOSUMI_JOURNAL_COMPACTION_MAX_AGE_HOURS` — age threshold for the oldest
  entry. Default `168` (one week). Set to `0` to disable the age trigger.
- `TAKOSUMI_JOURNAL_COMPACTION_MAX_PASS_DURATION_SEC` — soft cap on a single
  compaction pass. Default `300`. A pass that exceeds the cap yields and resumes
  on the next tick.
- `TAKOSUMI_JOURNAL_COMPACTION_DISABLED` — set to `1` to disable automatic
  compaction; manual passes still run. Disabling automatic compaction is
  intended for incident response, not steady state.

Operators may also place targeted holds through internal operator tooling:

- hold blocks compaction for a specific journal range, e.g. during an open
  investigation.
- release clears the hold.

Holds are recorded under the `lock-acquired` and `lock-released` audit events.

## Inspection

Operators inspect compaction state through the operator surface:

- status reports the active base snapshot pair, the size and age of the
  post-base tail, and the next trigger that will fire.
- dry-run reports the entries that would be dropped without performing the
  truncation.
- compact performs the pass.

Inspection commands require the operator bearer.

## Related architecture notes

- `reference/architecture/operation-plan-write-ahead-journal-model` — WAL stage
  enum, idempotency tuple, replay rules.
- `reference/architecture/snapshot-model` — base snapshot semantics and snapshot
  garbage collection.
- `reference/architecture/observation-drift-revokedebt-model` — RevokeDebt
  status rules referenced by retention.
