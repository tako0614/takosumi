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
- Report: `/root/dev/tmp/tk0118/phase4-fix-report.md`, with exact heads, checks,
  finding dispositions and any unresolved limits.
- Reversal: revert the code changes without deleting retained link history.
  Operator backfill must record its dry-run and applied IDs; revocation repairs
  mistaken consent forward without restoring secret values or historical grants.
