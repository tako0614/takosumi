# TASK-0118 Phase 1 independent review fixes

- Owner/repository: Takosumi only; worktree `takosumi-independent-apps-20261028`.
- Delivery: fix existing PR #633, then merge its branch normally into stacked PR
  #634; normal pushes only. No merge to main, deploy, or live database access.
- Baseline integration: merge `origin/main`, including Dependency/OutputShare
  retirement `5c96fd74c`, normally into #633 before applying fixes.
- Scope: memory/PostgreSQL/D1 Source polling and snapshot settlement, runner
  archive custody, deterministic app Source claims and legacy plan recovery.
- Authority: preserve Workspace admission epochs, Run lease fences, immutable
  archive identity, tenant boundaries, and exact replay detection. Discarded
  source archives may be released only by their host storage owner.
- Persistence: optional internal Source JSON polling attempt timestamp; no DDL
  or data migration. Existing ownerless records keep polling behavior.
- Validation: focused regression tests in all three stores and real install-plan
  coordination, every static portable phase, complete `bun run check`, then
  GitHub Actions `check and test` on both pushed PR heads.
- Evidence/report: `/root/dev/tmp/tk0118/phase1-fix-report.md` and associated
  local logs. Do not record credentials or production data.
