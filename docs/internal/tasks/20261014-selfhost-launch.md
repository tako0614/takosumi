# TASK-0031 self-host documentation recovery

- Repository/worktree: Takosumi only, `takosumi-selfhost-20261014`.
- Branch/base: `docs/takosumi-selfhost-launch-20261014`, main `1b08419c1`.
- Scope: recovery-plan row 5; rewrite bilingual self-host procedures against
  current node-postgres source and complete runtime Store URL forwarding.
- WIP `5e401695a` is a read-only specification memo; no file copies or cherry-picks.
- PR #430 is open: leave its Store capability changes to that owner. This work
  uses the existing discovery endpoint and dashboard runtime URL loader.
- Verification: focused regression tests; disposable local Compose project on
  loopback port 26401; migrations, health, dashboard, runtime discovery,
  upgrade and backup/restore rehearsal; full owner gate on ports 26411/26412.
- Boundaries: no source-pin changes, other worktree writes, main pushes, force
  pushes, staging/production deployment, or existing data/credential changes.
- Publication: ordinary feature-branch push and ready PR. Request QA from the
  quality/release owner; staging publication belongs to the stagingsync owner.
- Merge only after GitHub CI is green and the quality/release owner explicitly
  approves. Otherwise leave the PR awaiting that approval.

## Local evidence before publication

- Regression proof: declaring the Store setting without Compose forwarding
  failed the procedure contract (7 pass / 1 fail); forwarding it fixes the gap.
- Focused suite: 53 pass / 0 fail across seven files covering procedure
  contracts, composed-app discovery, server-to-dashboard runtime selection,
  URL rejection, and the existing platform discovery contract.
- Disposable Compose projects: `takosumi-selfhost-docs-20261014` on loopback
  26401 and `takosumi-selfhost-restore-docs-20261014` on loopback 26402.
  Caddy was never started. Generated secrets and dump files stayed outside Git.
- Fresh boot: 105 control migrations (head 117), 44 Accounts migrations;
  both PostgreSQL and Accounts healthy; `/healthz` returned 200 with database OK.
- Browser: the unauthenticated Takosumi sign-in screen rendered at 26401 and
  at the restored 26402 origin, with no JavaScript page errors. No upstream
  provider was configured; this is not evidence of authenticated sign-in.
- Upgrade rehearsal: stop Accounts, rebuild, run both forward migration
  catalogs (0 pending), start with `--wait`, then repeat health verification.
- Backup/restore: stop Accounts, `pg_dump -Fc`, validate `pg_restore --list`,
  restore with `--exit-on-error --no-owner` into the new project's empty DB,
  repeat migrations and health/browser checks. The probe row and 105/head-117
  migration ledger were read back from the restored database.
- Runtime Store: discovery published the configured public URL. Recreating
  Accounts with a second URL and `--no-build` changed discovery while preserving
  the same image ID. The dashboard loader is covered by the integration test.
- Independent read-only review: initial findings about project selection,
  readiness, upstream configuration, fail-stop behavior, and links were fixed;
  final review has no blockers. This is not the quality/release owner's approval.
- Publication evidence records the final head, the full owner-gate command and
  result, and cleanup in the PR body; approval/CI status remains external.
