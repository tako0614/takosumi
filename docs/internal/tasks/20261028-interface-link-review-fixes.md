# TASK-0118 Phase 4 independent review fixes

- Owner/repository: Takosumi only. Delivery is the existing #640 storage → #641
  runtime → #642 install → #643 visibility → #644 store → #645 docs stack.
- Integrate current `origin/main` first at #640, then ordinary predecessor merges
  upward. Preserve the other writer's Source retirement work. Normal pushes;
  no PR merge, deploy, or live database mutation.
- Authority: repair consent retry, legacy materialized Binding adoption and
  operator dry-run backfill, provider-admin compare-and-set, requirement
  reconciliation isolation, candidate consent snapshots, and uninstall cleanup.
  Providers are Capsule-owned Interfaces within the same Workspace.
- Persistence: retain v76 as the additive `interface_links` table only. Existing
  v75 remains a supported runtime and staging/auth staging schema. The later
  per-app ownership expansion is v77 and a separate fenced rollout; no migration
  is applied by this task. Backfill is an explicit operator action after v76.
- Storage slice #640 must ship together with #641 runtime compatibility and
  backfill support. Do not deploy #640 alone: its old requirement writer does
  not yet attach consent provenance.
- Evidence supplied by the operator on 2026-10-28: staging/production have no
  legacy required-Interface Bindings, Workspace-owned Interfaces, or required
  Interfaces in InstallConfigs. Production Control D1 is v75. No additional
  live read or mutation is needed for this repair.
- Validation: regressions for each behavior, storage parity across memory,
  PostgreSQL and D1, focused browser checks, complete `bun run check`, and
  GitHub Actions `check and test` at every final PR head.
- CI: quality checks every pull request base, including stacked feature bases;
  push checks remain limited to main. No deployment workflow is changed.
- Test process: each portable test file uses Bun's fresh global isolation to
  keep native host fixtures independent in the full sweep. File inventory,
  six-shard partitioning and test deadlines remain unchanged.
- Reversal: revert the code changes without deleting retained link history.
  Operator backfill must record its dry-run and applied IDs; revocation repairs
  mistaken consent forward without restoring secret values or historical grants.

## Second review round

- Same six-PR stack and delivery boundary: normal predecessor merges and pushes;
  no PR merge, deploy, backfill, or live schema/data mutation.
- Repair orphaned required-Interface Binding cleanup at preparation and sign-in;
  keep permission reorder/reduction compatible while requiring fresh consent for
  increases. Health reports the increase as `reapproval_required`.
- Keep installs safe before the v76 link store exists, compare candidate echoes
  with current candidates, and revoke links in the domain abandon operation.
- Preserve connection/Capsule errors ahead of review, report unknown installed
  summaries, and correct API shapes and automatic-selection exceptions in docs.
- Validation requested: focused regressions, the complete local `bun run check`,
  and real `check and test` success at all six final heads. Passing GitHub Actions
  runs are evidence for the exact heads they tested; confirm the final head of
  each PR. The previous local full-gate run had unrelated fixture timeouts and
  was interrupted, so it is not a passing result.

## Third review round

- Automatic post-create Binding cleanup uses the revocation reason `Superseded`
  when its link becomes unavailable, so the next sign-in can retry after recovery.
- Retry install discards through domain abandonment even for already-destroyed
  Capsules. Their link cleanup remains idempotent after Workspace management stops;
  active Capsule mutations remain behind the management admission fence.
- Keep Store loading copy neutral. Correct copy and documentation to match the
  implementation, including automatic InterfaceLink selection.
- Parent must run the final complete local `bun run check`. Confirm real
  `check and test` CI on every exact final PR head; do not treat an earlier head
  as evidence for a later one.
- Delivery remains normal predecessor merges and pushes only: no PR merge,
  deploy, operator backfill, or live database/schema/data mutation.
