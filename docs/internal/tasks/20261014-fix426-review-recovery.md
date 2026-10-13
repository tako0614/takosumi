# PR #426 review recovery

- Owner/repository: Takosumi only; worktree `takosumi-fix426-20261014`,
  branch `fix/takosumi-426-review-findings-20261014`, base `1b08419c`.
- Scope: retain a newly created Source's pending auto-sync update on PATCH
  failure and expose an explicit retry without recreating its Source or Plan;
  advertise the configured public Store capability in Worker and node-postgres
  discovery. Add regression coverage for both merged PR #426 review findings.
- Behavior/authority: changes dashboard recovery and public capability discovery;
  no schema migration, data cleanup, new authorization, or source pin change.
- Validation: focused regression tests, then
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26381 TAKOSUMI_DOCS_BROWSER_PORT=26382 bun run check`.
  Record commands and results in the recovery PR body.
- Publication: ordinary branch push, ready PR, and a PR comment requesting
  `品質・リリース担当へQA確認依頼` and stating `staging公開はstagingsync担当`.
  Squash merge only after GitHub CI is green and quality/release has left an
  explicit approve comment; otherwise stop awaiting review.
- Excluded: main push, force push, staging/production deployment, source pin
  edits, takos1 or other worktrees, destructive data or credential operations.
