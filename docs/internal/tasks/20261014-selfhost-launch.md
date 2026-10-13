# TASK-0031 self-host documentation recovery

- Repository/worktree: Takosumi only, `takosumi-selfhost-20261014`.
- Branch/base: `docs/takosumi-selfhost-launch-20261014`, main `1b08419c1`.
- Scope: recovery-plan row 5; rewrite bilingual self-host procedures against
  current node-postgres source and complete runtime Store URL forwarding.
- WIP `5e401695a` is a read-only specification memo; no file copies or cherry-picks.
- PR #430 was open at the start and merged during verification: leave its Store
  capability changes to that owner. This work
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
- Full-gate finding: the existing stale-chunk browser test read its request
  count on the transient first fallback before automatic reload finished.
  The failure trace shows the second chunk request after the synchronous
  assertion. The test now waits for that request, keeping the same `>=2`
  requirement, before checking the final card and navigation recovery.
  Product reload behavior is unchanged; the complete gate is rerun.
- Docs build finding: operational runbooks physically exist but are excluded
  from the public VitePress site. Backup pages now link to their repository
  source instead of an unpublished site route, preserving the exclusion.

## QA documentation follow-up

- Continue existing open PR #433 on `docs/takosumi-selfhost-launch-20261014`.
  The initial local/remote head was `c6e1081c496a0ca51dc793d6634409320169318d`.
- Merge main `63eb47c24ead54e2acd18e7f1f1f051103bcf116` normally, preserving
  history, to include the approved #432 sealed backup store. Resolve the Store
  URL/backup-directory forwarding conflicts by retaining both settings and
  preserve the detailed PostgreSQL backup/restore procedures alongside #432's
  runtime-volume and custom state-reader guidance.
- Address the two non-blocking QA recommendations on #432: the backup
  directory is effectively required because an unavailable export is skipped
  without stopping destroy; old exports need the passphrase used to create
  them, even after a passphrase change. Update both languages and the
  distribution README; correct the adjacent runner/artifact-store wording.
- Validation: `env -u NODE_ENV bun run check:authoritative-docs`; focused
  existing self-host procedure/file-store/export tests; complete
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26411 TAKOSUMI_DOCS_BROWSER_PORT=26412 bun run check`
  including docs build/browser checks. Record the exact tested head and results
  in PR #433, then request quality/release QA again.
- Scope remains Takosumi only. No deployment, takos1 operations, force push,
  runtime behavior change beyond the already merged main changes, or merge
  of the PR is part of this follow-up.
