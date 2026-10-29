# TASK-0118 independent-meter payer after ownership transfer

Scope: Takosumi OSS usage payer resolution for independent (non-Core-Run)
meter events after an app ownership transfer, and the legacy usage payer
backfill. It follows the D review (P2) on PR #653 and the independent review
of PR #666. Code only: no schema change, migration, data mutation, merge or
deploy. TASK-0109 billing launch remains stopped.

Guiding rule: wrongly charging an account is worse than leaving an event
unattributed.

## Decision

PR #653 left every independent meter event of a transferred app
(`ownership_epoch > 0`) unattributed because nothing recorded payer history.
The B transfer ledger (`capsule_ownership_transfers` /
`takosumi_capsule_ownership_transfers`) now supplies it. An accepted row ends
epoch `ownership_epoch` (held by `from_account_id`) and starts epoch
`ownership_epoch + 1` (held by `to_account_id`) at its acceptance time.

- Acceptance time is the accepted row's `updated_at`. Both SQL and D1 accept
  paths already write it once, in the pending -> accepted CAS that swaps the
  owner and increments the epoch. Accepted rows are terminal, so no column or
  DDL was needed.
- A meter's `createdAt` is a claim on the meter's clock for an aggregated
  measurement. Acceptance times are server instants. An event therefore stands
  for usage in the server-clock span
  `[max(T - G, app creation), min(T + G, recordedAt)]`. It is attributed only
  when that whole span lies inside one half-open owner interval
  `[acceptance, next acceptance)`. Otherwise it is unattributed.
  - The upper clamp holds because usage happens before the server receives
    its report.
  - G is `APP_PAYER_BOUNDARY_GUARD_MS` = 2 hours. It must cover the
    aggregation window plus clock skew. `UsageEvent` carries no usage window,
    and `createdAt` may name either end of a bucket. Independent meters must
    therefore aggregate over at most one hour and keep clocks within one hour
    of the server's.
  - A coarser producer needs a window-aware usage input, which is not in the
    contract today. When that input exists, attribute only if the whole
    reported window lies inside one interval.
- Claim bounds:
  - A claim earlier than the app's creation, or later than the recording time
    plus G, has no payer.
  - When the claim selects between owners (`ownership_epoch > 0`), it must also
    be no older than the recording time minus `APP_PAYER_MAX_LATENESS_MS`
    (7 days, for delayed batches and retry backlogs).
  - A never-transferred app keeps attributing older claims to its only owner.
- Other unattributed cases (never the current owner by default):
  - a missing row or epoch gap on the chain from the current owner back to the
    span's interval and its start boundary;
  - a current owner that is not the latest recipient;
  - owner discontinuity, or duplicate rows for one epoch;
  - a missing or non-canonical acceptance time;
  - acceptance times that do not strictly increase with the epoch;
  - a walk deeper than 64 transfers.
- Transfer drain:
  - A drain is `management_state = 'draining'` with a pending transfer whose
    `drain_management_epoch` equals the app's `management_epoch`.
  - During a drain, the current owner keeps only events whose span ends before
    the pending row's `created_at`. The in-flight acceptance is stamped after
    that row was created. Closed intervals stay attributable.
  - D1 has no row locks and stamps acceptance after committing the drain
    state, so this is its in-flight guard.
  - PostgreSQL also takes `FOR SHARE` on the Capsule row before its read.
    Acceptance holds `FOR UPDATE` and stamps the time after locking, so any
    acceptance the snapshot misses is stamped after the read.
- Epoch 0 uses the same snapshot and rules. Without an owner tuple or ledger
  (pre-backfill or legacy schema), no transfer can have been accepted. The
  initial owner then applies under the same claim bounds.
- Unchanged:
  - The Core Run reserved payer stays pinned in the durable Plan audit.
  - Pre-change Plan Runs keep their epoch-0 rule.
  - Runner minutes always carry a Run and are unaffected.

## Legacy usage payer backfill

`planAppOwnershipBackfill` used to assign every payer-less app usage event to
that app's current owner, even after a transfer. The tool re-plans on each run,
so re-running it would have turned intentionally unattributed events into
charges. It now assigns a payer only for never-transferred apps
(`ownership_epoch = 0`). Payer-less events of transferred apps are listed
under `transferredAppUsage`. That list is a report only: it does not block
apply, and the events stay unattributed.

## Read path

`OpenTofuControlStore.getAppOwnershipHistory(capsuleId, at)` issues one
recursive statement on SQLite/D1 and PostgreSQL. The statement reads the owner
tuple first. It then walks accepted rows by `to_account_id = previous owner`
through the existing `(to_account_id, state)` recipient index; the ledger has
no capsule index. The caller passes the span start, so the walk reads every
acceptance that could fall inside the span. It stops one row past the first
acceptance at or before that instant. The memory store mirrors the same walk
over an in-memory ledger mirror. The pure resolver `appPayerAtEventTime`
validates every reached row before choosing an interval.

## Deferred and known limits

- An index on `(capsule_id, state, ownership_epoch)` for the transfer ledger
  is deferred to the later contract schema change; this PR adds no DDL.
  (Later added as D1 v79 / PostgreSQL v125 in the same rollout window.) The
  recipient walk cannot see an accepted row off the chain (for example a
  second accepted row for an epoch with a different recipient). The accept CAS
  cannot produce one: there is one pending row per app and an epoch CAS.
- The PostgreSQL `FOR SHARE` read takes a row lock on the Capsule for every
  independent meter event of an app. It briefly waits behind ownership writers
  holding `FOR UPDATE`.
- The concurrency claims (PostgreSQL lock ordering, D1 drain-before-stamp) are
  argued from the accept code paths, not tested. PGlite is a single
  connection, and the SQLite-backed D1 fake serializes statements.

## Verification

`tests/core/domains/deploy-control/transfer_meter_payer_test.ts` runs every
case on memory, PGlite and SQLite-backed D1:

- spans before, across and after one acceptance, at both guard boundaries;
- two transfers;
- claims after the recording time plus G, before app creation, and older than
  the lateness bound (unattributed only for transferred apps);
- incomplete or ambiguous history: missing row, epoch gap, missing or
  non-canonical acceptance time, reversed acceptance order, owner
  discontinuity, duplicate epoch;
- transfer drain with the pending-creation bound, versus other drains and
  non-draining pending transfers;
- real PostgreSQL/D1 `acceptTransfer`: live usage within G of the acceptance
  stays unattributed, and usage clear of it resolves on either side.

`tests/core/domains/app-ownership/backfill_test.ts` covers re-running the
backfill after a transfer on memory, PostgreSQL and D1: the rows stay
unattributed, and never-transferred apps are still backfilled.
