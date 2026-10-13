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
- Conditional staging: only after an authorized merge, use a clean merged-main
  checkout and the user-specified staging config through the repository deploy
  entrypoint. Read status first, use the documented lane, and verify status and
  the affected functionality on `app-staging.takosumi.com`. Schema operations
  follow only the staging predeploy procedure. Serialize publication with the
  Takosumi stagingsync session and preserve incomplete-deploy evidence without
  blind retries. Record outcome and Version in the PR.
- Excluded: production targets/configs/domains/databases, destructive storage or
  credential operations, registry/image publication, release tags, force push,
  and modifications to sibling repositories or other sessions' worktrees.
- Current approval state at handoff preparation: no PR comments or reviews;
  merge and staging remain conditional on QA/CTO judgment.
