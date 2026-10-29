# TASK-0118 independent-meter payer after ownership transfer

Scope: Takosumi OSS usage payer resolution for independent (non-Core-Run)
meter events after an app ownership transfer. It follows the D review (P2) on
PR #653. Code only: no schema change, migration, data mutation, merge or
deploy. TASK-0109 billing launch remains stopped.

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
- The payer of an event at time T is the owner whose half-open epoch interval
  contains T: the original owner (`from_account_id` of the epoch-0 transfer)
  before the first acceptance, otherwise the recipient of the latest
  acceptance at or before T. An event at the acceptance instant belongs to the
  recipient.
- Unattributed, never the current owner: an event time after the record time;
  a missing row or epoch gap on the chain from the current owner back to T's
  interval and its start boundary; a current owner that is not the latest
  recipient; owner discontinuity; duplicate rows for one epoch; a missing or
  non-canonical acceptance time; acceptance times that do not strictly
  increase with the epoch; a walk deeper than 64 transfers.
- A transfer drain (`management_state = 'draining'` with a pending transfer
  whose `drain_management_epoch` equals the app's `management_epoch`) leaves
  only the current open interval unattributed. D1 has no row locks and stamps
  acceptance after committing that drain state, so an in-flight acceptance
  can already have fixed the boundary. Closed intervals stay attributable.
  PostgreSQL also takes `FOR SHARE` on the Capsule row before its read.
  Acceptance holds `FOR UPDATE` and stamps the time after locking, so any
  acceptance the snapshot misses is stamped after the read.
- Epoch 0 uses the same snapshot, so a first transfer in flight is handled
  too. Without an owner tuple or ledger (pre-backfill or legacy schema), no
  transfer can have been accepted and the initial-owner rule from #653 applies.
- The Core Run reserved payer stays pinned in the durable Plan audit, and
  pre-change Plan Runs keep their epoch-0 rule. Runner minutes always carry a
  Run and are unaffected.

## Read path

`OpenTofuControlStore.getAppOwnershipHistory(capsuleId, at)` issues one
recursive statement on SQLite/D1 and PostgreSQL. The statement reads the owner
tuple first. It then walks accepted rows by `to_account_id = previous owner`
through the existing `(to_account_id, state)` recipient index; the ledger has
no capsule index. It stops one row past the first acceptance at or before T.
The memory store mirrors the same walk over an in-memory ledger mirror. The
pure resolver `appPayerAtEventTime` validates every reached row before
choosing an interval.

The recipient walk cannot see an accepted row off the chain (for example a
second accepted row for an epoch with a different recipient). The accept CAS
cannot produce one: there is one pending row per app and an epoch CAS.
Detecting such corruption would need a capsule-keyed scan or a new index;
this change avoids both.

## Verification

`tests/core/domains/deploy-control/transfer_meter_payer_test.ts` runs every
case on memory, PGlite and SQLite-backed D1:

- before and after one transfer, including a late event whose time precedes
  the acceptance;
- two transfers;
- an event after the record time;
- incomplete or ambiguous history: missing row, epoch gap, missing or
  non-canonical acceptance time, reversed acceptance order, owner
  discontinuity, duplicate epoch;
- transfer drain versus other drains and non-draining pending transfers;
- real PostgreSQL/D1 `acceptTransfer` stamping the boundary later meters use.

The existing #653 personal-billing and required-composition tests still pass
unchanged.
