# Backup and Restore

> Stability: stable Audience: operator See also:
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Secret Partitions](/reference/secret-partitions),
> [Migration / Upgrade](/reference/migration-upgrade), [CLI](/reference/cli),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

This page defines the Takosumi v1 backup and restore protocol for operator
self-host deployments. It enumerates which storage records are critical to back
up, which records are regenerable and may be skipped, the on-disk backup format,
the point-in-time consistency invariants, and the ordered restore procedure that
preserves audit-chain integrity.

The protocol is logical, not physical. Snapshots are taken from the kernel's
storage abstraction, not from the underlying SQL / object store / filesystem
layout. Operators may layer physical backups underneath for redundancy, but a
Takosumi-conformant restore always goes through the logical path defined here.

## Backup scope

Storage records partition into two classes: **critical** records that must be
backed up to recover the kernel, and **regenerable** records that the kernel
reconstructs after a restore.

### Critical (must back up)

| Record                       | Why critical                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `ResolutionSnapshot`         | Immutable plan input; required to replay the WAL.                     |
| `DesiredSnapshot`            | Operator-authored intent; cannot be reconstructed from runtime state. |
| `ActivationSnapshot`         | Records which Resolution is currently active per Space.               |
| `OperationJournal` (WAL)     | Idempotency tuples and effect digests; without this, replay diverges. |
| `RevokeDebt`                 | Outstanding rollback obligations; loss leaks effects.                 |
| `Approval`                   | Bound `approvedEffects` for in-flight and historical operations.      |
| `SpaceExportShare`           | Cross-Space sharing state including freshness and revoke records.     |
| `AuditLog`                   | Hash-chained event log; loss breaks chain verification.               |
| Secret partition (encrypted) | Operator-managed master-key-encrypted secret material.                |
| Catalog adoption record      | Which catalog releases the operator has installed and trusts.         |

These records collectively form the **backup set**. A backup that omits any one
of them is non-conformant.

### Regenerable (no backup needed)

| Record                           | How regenerated                                                            |
| -------------------------------- | -------------------------------------------------------------------------- |
| `ObservationSet` (current state) | Recomputed by the next observe phase against runtime-agent describe.       |
| `DriftIndex`                     | Recomputed from `ObservationSet` and the active `ResolutionSnapshot`.      |
| `ExportMaterial` cache           | Re-derived from `ResolutionSnapshot` and managed objects.                  |
| Generated object cache           | Re-rendered from link projection rules and source exports.                 |
| `ObservationHistory` (opt-in)    | Operator-configurable; treated as regenerable unless the operator pins it. |

Operators **may** include regenerable records in a backup for faster warm-up
after restore, but a conformant restore must succeed without them.

## Backup format

Logical exports are produced as a single multi-record stream in kernel-internal
JSON. Each record carries:

- `spaceId` — owning Space ID. Cross-Space records (audit chain globals, catalog
  adoption) use the reserved `space:_global`.
- `id` — the resource ID following [Resource IDs](/reference/resource-ids).
- `kind` — the record kind (e.g. `resolution-snapshot`, `journal-entry`).
- `body` — the record contents.
- `chainRef` — for audit-chained records, the hash chain reference pointing to
  the immediately prior chained record.

The stream is human-readable JSON, one record per line, ordered such that
`chainRef` always points backward to a record already emitted in the stream.
Restore reads the stream sequentially and verifies the chain as it goes.

The format is stable within a kernel major version; cross-major restore goes
through migration (see [Migration / Upgrade](/reference/migration-upgrade)).

Rationale: cross-major restore は schema migration を経由する別 protocol で
扱う。format を major に bind することで restore path 自体は logical import
のみで完結し、restore tool に migration logic を埋め込まずに済む。schema
互換層を restore と migration の両方に二重実装する保守コストを避け、cross-major
recovery は明示的に source-major restore → migration の 2 段階で operator に
意図させる設計にしている。

## Backup invariants

A backup must satisfy three invariants. Operator backup tooling must hold them
by construction.

### Point-in-time consistency

The backup acquires a backup-mode lock across all Spaces and all critical record
stores. Under the lock:

- All critical records are exported as a single point-in-time snapshot.
- In-flight operations either complete to a WAL terminal stage before the lock
  is granted, or are paused (their WAL cursor is included as the latest cursor
  in the backup).
- New deploy / approve / observe writes are rejected with `failed_precondition`
  and `retryable: true` for the duration of the lock.

Backup duration is bounded by the per-Space lock TTL. Operators tune the TTL;
the default is conservative enough that real-world backup windows fit inside a
single TTL.

### Secret partition non-re-encryption

Secret partition records are exported **as-is**, encrypted under the operator's
master key. The backup tool never decrypts and re-encrypts secret material. This
invariant has two consequences:

- The backup is unusable without the master key, even if the export stream
  leaks.
- Restore requires the operator to provide the same master key (or a master key
  whose key derivation tree contains the same partition keys); a mismatched
  master key fails restore at the secret-partition read step.

### Cross-Space ordering preservation

The audit chain rotates globally, not per Space. The backup preserves the global
chain order: when records from different Spaces share a chain segment, their
relative emission order in the export stream matches the chain hash linkage.
Restore verifies the global chain during ingest; out-of-order ingest fails fast.

## Restore flow

Restore is a six-step sequence. Each step is a hard gate; the next step must not
begin until the prior step verifies.

### 1. Initialize storage

The target storage is either empty or initialized to the same kernel schema
version that produced the backup. Operators verify the schema version before
restore. Cross-major restore is handled by migration and is rejected at this
step (see boundary section below).

### 2. Inject secret master key

The operator supplies the master key (or master-key derivation material) before
any record ingest. The key is held by the operator's secret backend; the restore
tool reads it through the same factories the kernel uses at runtime.

### 3. Logical import

The restore tool ingests the export stream transactionally in dependency order:

1. Catalog adoption records.
2. `Approval` records.
3. `DesiredSnapshot` records.
4. `ResolutionSnapshot` records.
5. `ActivationSnapshot` records.
6. `OperationJournal` (WAL) entries, ordered by per-Space WAL cursor.
7. `RevokeDebt` records.
8. `SpaceExportShare` records.
9. `AuditLog` entries.
10. Secret partition entries (encrypted blobs).

Each record's identity and content are checked against the encoded form on
ingest. Identity collisions abort restore.

### 4. Audit chain verification

Once `AuditLog` is fully ingested, the restore tool walks the chain from genesis
and verifies every hash link. A broken chain aborts restore with no record
committed (the transaction from step 3 is rolled back on failure).

### 5. Lock store reconstruction

In-flight operations recorded in the WAL are reconciled. For each operation
whose WAL terminal stage is not reached:

- If a `commit` cursor exists with a recorded effect digest, the operation is
  marked completable; the apply pipeline finishes it on the first post-restore
  tick using `recoveryMode = continue`.
- If a `commit` cursor is absent, the operation is marked rollback- pending; the
  apply pipeline schedules `recoveryMode = compensate`.

The cross-process lock store is rebuilt from in-flight operation metadata. No
new operations are dispatched until reconstruction completes.

### 6. ActivationSnapshot re-evaluation

Activation state from the backup is restored as the authoritative intent, but
per-object health (`observe` outputs) is **not** restored from the backup (it is
regenerable). The first post-restore observe tick rebuilds `ObservationSet` and
`DriftIndex` from runtime-agent describe.

Until the first observe tick completes, `LifecycleStatus` for restored objects
is reported as `unknown`. Operators should expect a warm-up window proportional
to the number of restored objects.

## Post-restore behaviour

### DesiredSnapshot immutability

`DesiredSnapshot` records are immutable on restore. Any pending desired-state
change that was not yet snapshotted at backup time is not preserved; operators
re-author and re-deploy.

### In-flight operation resolution

In-flight operations resume through the recovery modes recorded during step 5.
The
[Provider Implementation Contract](/reference/provider-implementation-contract)
governs how each Implementation must treat `recoveryMode = continue` versus
`recoveryMode = compensate`.

### GroupHead and canary state

`GroupHead` pointers and canary / shadow rollout state are part of
`ActivationSnapshot` and are restored exactly as they were at backup time. A
canary that was 30% rolled out remains 30% rolled out after restore; the rollout
state machine continues from that point on the next deploy.

## Restore boundary

Restore is **guaranteed within the same kernel major version only**. Cross-major
restore must go through migration. The migration path is:

1. Restore into a kernel running the **source** major version.
2. Run the operator-published rolling upgrade procedure (see
   [Migration / Upgrade](/reference/migration-upgrade)) to advance to the target
   major version.

The restore tool refuses cross-major direct restore at step 1 and emits a closed
`failed_precondition` error pointing at the migration documentation.

## Operator Surface

The current public `takosumi` CLI does not expose backup / restore commands.
Backup and restore are operator-only workflows that must be driven through
internal control-plane tooling or deployment automation until a public operator
CLI surface is implemented and documented in [CLI](/reference/cli).

- Backup produces the export stream under the point-in-time lock described
  above.
- Restore runs the six-step flow above against initialized empty storage.

Both commands require operator-bearer credentials, not deploy bearers. Both
commands record their progress through the audit events below.

## Audit events

Backup and restore emit dedicated audit events into the same hash chain as
runtime kernel events:

| Event               | Emitted at                                                      |
| ------------------- | --------------------------------------------------------------- |
| `backup-started`    | Lock acquired, before record export begins.                     |
| `backup-completed`  | Final record written and lock released.                         |
| `restore-started`   | Storage initialized and master key accepted.                    |
| `restore-completed` | Step 6 finished and the kernel transitions to normal operation. |

Each event carries the backup's chain head hash. Verifying a restore against its
backup amounts to checking that the `restore-completed` event's chain head
matches the `backup-completed` event's chain head.

## Related design notes

- docs/design/snapshot-model.md
- docs/design/operation-plan-write-ahead-journal-model.md
- docs/design/observation-drift-revokedebt-model.md
- docs/design/operational-hardening-checklist.md
- docs/design/operator-boundaries.md
