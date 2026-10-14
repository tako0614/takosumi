# Issue #456: fair recovery sweep traversal

- Owner: Takosumi only; branch `fix/recovery-sweep-cursor-20261014`.
- Base: `origin/main` at `2d4619ccf3d318606683d60f2b9ba9ad4199d10b`.
- Launch prerequisite: stale auto-plan, scheduled drift, and ordinary Run repair
  must eventually visit targets beyond their first bounded window.
- Scope: internal scheduled traversal, paired PostgreSQL/D1 storage, in-memory
  parity, minimal additive cursor migration, regression tests, and lifecycle docs.
- Authorization: issue, ordinary branch push, ready PR, independent review,
  complete local gate, formal QA request for the exact complete head.
- Prohibited: merge/deploy, production/staging access or publication, force-push,
  main push, other terminals/worktrees/takos1 changes, DeckIDE restart/new deck.

## Contract

Each lane has a persisted keyset position and a fixed upper tuple for its current
lap, owned by `OpenTofuControlStore`.
Selecting a bounded page and advancing that position is one atomic storage
operation. PostgreSQL serializes allocation with a locked lane row; D1 does so
inside a transactional batch. The cursor has no target foreign key. Deleting the
last selected target, empty sets, and end-of-range wrap remain valid. The upper
tuple is captured at lap start and refreshed on wrap, so continuous new arrivals
cannot postpone the end of the current lap.

A page is allocated before external effects. Failed targets and a crash after
allocation remain eligible and are visited on the next lap; no attempt/effect is
marked successful by cursor advancement. With continuing successful sweep allocations, continuously eligible targets
with stable keys are allocated in finitely many ticks, including while newer
targets arrive. Repeated processing failures in the prefix do not impede traversal.
This does not promise exactly-once effects or progress while the database/cron is
unavailable. The existing Run owners/admission/approval/effect fences remain the
only mutation and idempotency authority.

Repair preserves current heartbeat JSON and latest billing marker eligibility;
ordinary operator reads retain their existing ordering. The independently fair
runtime-secret retirement outbox and its attempt claims remain unchanged.
Auto-plan excludes archived Workspaces and preserves pending-plan suppression.
Drift passes the selected Capsule IDs to RunGroup creation, which rechecks active
status and Workspace membership without replacing missing targets with a prefix.
Tick caps and opt-in flags remain unchanged.

## Migration and validation

PostgreSQL v118 / D1 v71 add the cursor table with three seeded lanes.
The table is additive, contains only a lane and non-secret keyset metadata,
and does not backfill or rewrite domain rows. Paired migration catalogs and schema
mirrors are updated using current repository conventions. Old cursor-less code
can ignore the new table; rollback need not delete it. Production migration and
publication are left to the release owner.

Base red: 0 pass / 3 fail, 13 assertions. Seven targets with cap two remain stuck
at the first two after four ticks; 5001 eligible Runs remain stuck at 5000 after
two ticks despite permanent dispatch failure. Storage regressions cover restart,
overlap, deleted target, wrap/empty, equal-key ordering, and continuous append without postponing
crash-page recovery. Final commands,
counts, independent review, complete head and log digests belong in the PR and
private evidence `/root/dev/takos/.operator-private/Takosumi-sweep-20261014/`.
