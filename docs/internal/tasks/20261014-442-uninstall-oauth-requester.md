# Issue #442: uninstall OAuth and legacy requester follow-up

- Owner: Takosumi only, worktree `takosumi-uninstall-oauth-20261014`, branch
  `fix/takosumi-uninstall-oauth-requester-20261014`. Clean latest-main baseline
  `d527e8c22e0cf463313df21233de8d028541158f` includes #437. #441 is open and
  being integrated by its owner; its route, route tests, API docs, run model and
  Core-spec files are outside this task's edit ownership.
- Authority: reject all OAuth schedule requests at shared Core admission with
  `failed_precondition` / `capsule_uninstall_oauth_unsupported` (HTTP 409).
  Existing authorization pins the exact grant. Default access-token TTL is
  5 minutes, versus 7 days of default grace. A warning would still create an
  unusable reservation. Refresh cannot replace the pinned grant; zero grace
  cannot guarantee background execution before expiry. Do not convert OAuth
  into account-only scheduling intent. Browser session and PAT remain supported.
- Legacy: keep #437's deadline fail-closed for requester-less rows, before any
  export/Plan/provider operation. Persist `uninstall_requester_missing` and
  `authorizationRejectedAt`; keep resources, state, data and metering. Never
  infer requester from an actor, audit event, current owner or membership.
  Scheduling replay cannot adopt an old row. An authorized owner/admin must
  cancel and schedule a new reservation with a new ID and full grace period.
  Existing OAuth reservations retain the exact-grant checks and stop on expiry.
  Already dispatched mutations require authorized forward repair.
- Storage: no DDL, backfill, durable-data rewrite or credential rewrite. Blocked
  requests keep their evidence and do not silently revive after authority is
  restored. Validate legacy block/audit/replay/cancel/replacement/completion
  against Memory, Postgres and D1. Validate public HTTP admission with real
  Core scheduling for OAuth, session and PAT, including unchanged Capsule and
  no scheduling Activity on OAuth rejection.
- Validation: regression tests first on the baseline (OAuth public admission
  and both 0/7-day Core admission must be red), then focused tests and full
  `env -u NODE_ENV bun run check`. Record exact command, head and results in PR.
- Publication: ordinary branch push, ready PR closing #442, and explicit PR
  comment requesting quality/release QA. Squash merge only after explicit
  QA approve for the exact head and all GHA checks green, with
  `--match-head-commit`. No main push or force-push.
- Release/reversal: this task publishes no runtime artifact and mutates no
  existing environment. Staging publication belongs only to stagingsync;
  hand off OAuth rejection and legacy cancel/reschedule behavior. A code revert
  restores misleading OAuth acceptance; do not revert #437's fail-closed checks.
  No production, deploy, takos1 or other-worktree operations are authorized.
