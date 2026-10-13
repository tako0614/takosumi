# TASK-0031 A / PR #422 review handoff

- Owner/repository: Takosumi only; branch
  `feature/takosumi-tanto-destroy-20261013`.
- Scope: integrate `origin/main` using an ordinary merge, rerun the complete
  local gate and focused uninstall tests, push the branch, update PR evidence,
  and request quality/release review.
- Authority/schema: the existing implementation adds system approval of eligible
  expired-uninstall destroy Plans and Postgres migration
  `deploy.capsule_uninstalled_status.expand`. Independent review must decide that
  authority change, the unchanged immediate DELETE/destroy-plan routes, migration
  numbering, and possible overlap with takos1 destroy work.
- Integration: merge commit `a3eb61e78` includes `origin/main` at `c56268c21`;
  no conflicts. Main's Postgres catalog ends at v116, so v117 remains available
  and this PR retains it. D1 has no new schema migration for this feature.
- Main advanced during verification to `eccdcd133` (dashboard PR #420). The
  second ordinary merge resolves the notification-renderer extraction by moving
  the scheduled/cancelled/blocked uninstall copy into shared
  `describeActivityEvent`, preserving both main's shared rendering and this PR's
  uninstall messages. The Postgres catalog still ends at v116.
- Verification: `env -u NODE_ENV bun run check` and the focused suite documented
  in PR #422; current commands and results will be recorded in the PR body.
- Publication order: ordinary feature push, ready-for-review, then the explicit
  quality/release review request. Squash merge is authorized only after passing
  checks, a quality/release approval comment, and no CTO/owner hold on the PR.
- Staging ownership (CTO, 2026-10-14 00:46 JST): staging publication belongs
  exclusively to the Takosumi stagingsync session. This session must not run
  `takosumi-platform-staging` or staging `-code` apply/plan/execute, and must not
  modify any sibling source pin. After merge, record
  `staging公開はstagingsync担当` in the PR and hand off without deploying.
- Excluded: production targets/configs/domains/databases, destructive storage or
  credential operations, registry/image publication, release tags, force push,
  and modifications to sibling repositories or other sessions' worktrees.
- Stage 2 authority (CTO, 2026-10-14 00:48 JST): quality/release QA has approved
  #422; v117 is collision-free and safe to rerun. In the absence of a CTO hold,
  integrate latest main without force push, record actor/time audit tests and
  local CI in the PR body, then squash merge. Latest fetched main at stage 2
  is `eccdcd13329debb4c8548487f7df92544e013b05`, already an ancestor of this
  branch; ordinary `git merge --no-ff origin/main` reports up to date.
- Follow-ups: #424 tracks DELETE API two-stage migration; #425 tracks deadline
  reauthorization of the original uninstall requester. DELETE remains immediate
  in #422. takos1 overlap assessment belongs to CTO and is outside this session.
- Stage 2 fixes also address the new code-review findings: cancelled or replaced
  uninstall requests cannot reuse a system-approved Plan (including the atomic
  storage admission fence); waiting requests rotate durably; one export attempt
  is claimed before side effects, and an uncertain claim blocks without retry.
  Independent source review and the full local gate are recorded in the PR.
