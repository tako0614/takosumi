# TASK-0118 ownership foundation review fixes

Scope: Takosumi only. Repair the introducing stacked changes in #652, #655,
#658, #659, #660 and #661, propagating each with normal merges. The foundation
first incorporates Phase 2 from main. No deployment or live migration is part of
this work. Other writers retain their own changes and migration authority.

## Storage and concurrency

Capsule JSON is an opaque concurrency snapshot: reads return the stored JSON
without adding or reordering ownership fields. Ownership and persisted artifact
roots are read through the app ownership port. D1 retains its v75/v76 expansion
bridge. A missing column is never cached, so an additive migration is visible to
an existing store instance; a present column can be cached.

PostgreSQL uses migration first: apply all storage migrations, including v123,
before starting the corresponding server. Runtime operations require that schema
and do not probe individual ownership columns or attempt partial old-schema
support. Version-boundary tests migrate legacy rows before using the new server.

Connection concurrency guards accept an unbackfilled null owner as well as the
canonical Workspace owner, while rejecting a changed owner. Capsule upserts must
never lower the execution authority epoch. Ownership writes compare the expected
ownership epoch; the transfer caller must supply the prior epoch when incrementing
it.

## Subsequent stack fixes

- #658: app-root plan/apply, recovery artifact paths and custody; bounded access
  lists; ownership concurrency and separate owner/root reads.
- #659: orphan reporting, payer resolution, freeze precondition and D1/PostgreSQL
  backfill coverage.
- #660: owner-only personal Workspace bootstrap remains available while
  organization creation and member mutations stay frozen.
- #661: shadow role comparison follows the same owner/admin mapping as the
  resolver. Shadow diagnostics sample 1% of Capsule-scoped checks; unsampled
  requests perform no shadow ownership/member reads. The legacy authorization
  result remains authoritative during this phase.

## Validation and handoff

Use focused behavioral tests plus affected static phases locally; the operator's
SSD constraint prohibits the local full gate. Every final PR head must pass the
CI `check and test` job. Record head commits, CI evidence and outstanding limits
in the operator-local A-fix report. Do not merge or deploy.
