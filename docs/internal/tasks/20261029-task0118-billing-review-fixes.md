# TASK-0118 Phase 8 billing review fixes

Scope: Takosumi OSS billing contract, orchestration, usage storage and focused
regressions for PR #653. Merge `origin/main`, including the Phase 3 ownership
foundation (`8a183757f`), without changing the authorization/member/transfer
implementation owned by writer B. No other repository is changed. TASK-0109
billing launch remains stopped; this work authorizes no live billing, payment,
provider, database, merge or deploy operation.

## Payer and compatibility decisions

- A Plan's reservation audit fixes its payer. Settlement and retries keep that
  payer after an ownership transfer. An old Plan without a payer pin remains
  unattributed after transfer, while retaining its Capsule association. Usage
  stores preserve the supplied payer, including its absence; they never infer
  a payer from the current app or Workspace owner.
- Billing reads the physical owner and ownership epoch together through a
  narrow store port. Ownership transfer/backfill need not rewrite Capsule JSON,
  so that JSON cannot supply the canonical billing owner. D1/PG parity tests
  exercise a real ownership-store CAS and invalid post-transfer owner rows.
- Legacy Plans without a Capsule and transferred Plans without a payer pin can
  finish terminal capture, release and runner metering without an invented
  payer, including with a required host. They remain unattributed and skip
  payer-dependent host calls. Required enforcement still refuses new work
  without an app or available reservation payer before provider mutation.
- Raw Postgres payer history explicitly converts `quantity` and `usd_micros`
  from driver text to numbers, including the unrated zero case.
- Contract 2.1.0 enforcement and quota contexts retain `workspaceId` for existing
  host adapters, alongside `capsuleId` and `payerAccountId`. The compatibility
  field does not replace the canonical payer. Remove it with the coordinated
  Phase 9 contract change, after Hosted consumers update.
- Existing independent meter producers need no new `ownerSnapshot` field.
  Their payer is the current app owner when usage is recorded; a producer's
  `runId` does not substitute for a Core reservation. Historical measurement
  attribution across transfers requires a separately coordinated public meter
  contract; this change does not claim that guarantee. Core runner settlement
  continues using its durable Plan audit.

## Operator ordering and deferred index migration

Complete and verify A's ownership **and usage-payer backfill before any ownership
transfer is enabled or accepted**. Backfill is the sole place that infers a
legacy usage payer from existing ownership. Once a transfer occurs, that current
owner cannot establish who owed unattributed historical usage. Do not use the
backfill to assign newly unattributed settlement rows after transfers. Keep
ownership writers stopped until the reviewed backfill inventory has no pending
writes; see [the backfill procedure](../../operations/app-ownership-backfill.md).

Payer history filters by payer and sorts by `(created_at DESC, id DESC)`. The
schema owner should add these equivalent indexes in a later additive migration
and update the D1/PG Drizzle mirrors and schema checks together:

```sql
-- D1 (future migration; not added or executed by this PR)
CREATE INDEX usage_events_payer_created_idx
  ON usage_events (payer_account_id, created_at DESC, id DESC)
  WHERE payer_account_id IS NOT NULL;

-- Postgres (future migration; not added or executed by this PR)
CREATE INDEX takosumi_usage_events_payer_created_idx
  ON takosumi_usage_events (payer_account_id, created_at DESC, id DESC)
  WHERE payer_account_id IS NOT NULL;
```

No migration version or production schema changes here. Verify the future
migration with populated legacy NULL and attributed rows, keyset pagination,
query plans and the schema owner's normal pre-mutation process.

## Verification and recovery

Focused tests cover PG-style numeric strings with an unrated row, unchanged
missing payer in D1/PG, actual stored ownership/epoch transfers, old unpinned
Plans, Capsule-less finalization and host compatibility contexts. Local checks
are restricted to focused tests and static phases under the task's SSD limit;
the PR CI owns complete portable qualification. Stop local work below 1.5 GB
available; delete only outputs created by this run.

The first full CI run found one retained Phase 3 parity expectation that still
required write-time payer inference. Its billing assertions now check both an
unattributed row with a known app owner and an explicitly pinned different payer
on Memory/PG/D1. Owner and Connection assertions in that test remain intact.

There are no data mutations to reverse. Before publication, fixes can be
reverted as source changes without dropping the additive Phase 3 schema. The
operator-local final report records the candidate commit, checks and CI result.
