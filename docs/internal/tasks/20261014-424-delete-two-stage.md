# Issue #424 / TASK-0031: safe default DELETE

- Owner: Takosumi only. Branch `feat/delete-two-stage-20261014`, base
  `fbeb79d33`. No sibling repository, takos1 or other worktree edits.
- Authority change: public Capsule DELETE now schedules destruction through the
  existing uninstall lifecycle. No DDL, migration, backfill or existing record
  rewrite. New reservations use the existing Capsule uninstall record.
- Related work: #422 owns the existing lifecycle; #437 / #425 owns requester
  capture and deadline/pre-dispatch reauthorization. #437 must merge before this
  PR, then this branch integrates its main commit with an ordinary merge and
  repeats focused and full validation. Do not alter #437's source branch.

## Final contract and migration

- Applied `DELETE /api/v1/capsules/{id}` returns 202 `{capsule, graceDays}` and
  shares exactly the `POST uninstall` admission, requester, captured Workspace
  management epoch and uninstall revision CAS. OSS default grace is seven days.
  No resource teardown happens at reservation. Resources/data/billing continue.
- Repeated DELETE while uninstalled returns the same reservation and deadline.
  Cancel is `POST cancel-uninstall` (200); it is idempotent after cancellation
  and refuses teardown already dispatched. Cancel/replacement invalidate old
  scheduled Plans and system approvals. Finalization retains #422's export,
  delete-only Plan validation, deterministic Run IDs and #425 reauthorization.
- `DELETE ?immediate=true` or `POST destroy-plan` returns a destroy Plan, not
  completed deletion. Current owner/admin + write credential is required to
  request it; explicit owner approval and guarded Apply remain mandatory.
  `immediate=false` selects grace. Other values or multiple values are 400.
- Never-applied DELETE retains atomic abandonment; it cannot silently turn into
  applied destruction during a race. Destroyed replay returns 200 with the
  terminal Capsule and `alreadyDeleted`. Lifecycle/management races refuse
  mutation with 409; ordinary Plan/Apply state/epoch fences prevent duplicate
  provider teardown even if more than one immediate Plan is requested.
- The Core internal token has no authenticated Accounts requester/grant. Applied
  default internal DELETE fails before scheduling with 409
  `capsule_uninstall_requester_unavailable`; use the public Accounts API.
  Explicit internal immediate Plans retain destroy/runner scopes and approval.
- Reservations/cancellations retain actor/time Activity events; immediate Plans,
  approval and Apply retain Run audit. Capsule-bound membership/scope refusal
  records `capsule.deletion_rejected` with trusted actor/action/reason. The
  earlier authentication/write-scope gate does not resolve a Capsule or write
  target Activity. Audit uses the existing best-effort Activity durability.
- The DELETE response/default is a breaking API contract. Compatibility period
  is the old artifact's deployment period before this reviewed release cutover;
  no date-based fallback or mixed implicit immediate behavior is introduced.
  Consumers can migrate ahead of cutover using existing POST uninstall and
  POST destroy-plan. New clients use DELETE default or explicit immediate mode.
  Dashboard is updated in the same artifact; CLI has no Capsule DELETE command,
  and this repository has no standalone SDK implementation. Existing MCP uses
  explicit POST destroy-plan. External clients must update response parsing.

## Verification and publication

- Focused route/client tests and #422/#425 lifecycle/store regressions, then
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26571 TAKOSUMI_DOCS_BROWSER_PORT=26572 bun run check`.
  Record commands, results, red baseline proof and exact tested head in the PR.
- Independent source review, ready PR with `Closes #424`, GHA green and explicit
  quality/release QA approval of the same head precede match-head squash merge.
  Wait up to 90 minutes, checking every five minutes; otherwise leave unmerged.
- Staging publication only after merge and exclusive acquisition of
  `/root/dev/takos/.operator-private/takosumi-staging.stagingsync.lock`.
  Confirm staging target/config before every deploy command and use the owner
  entrypoint's staging code lane. Record source/artifact/serving Version evidence.
- Postconditions: fresh test Workspace/Capsule only, providerless Apply, DELETE
  seven-day reservation, replay, cancel, explicit immediate Plan, owner approval,
  guarded Apply and terminal readback; record existing-data invariance separately.
- Reversal: restore the prior retained staging artifact only if its schema is
  compatible. Reverting this API change restores unsafe implicit immediate Plan
  semantics; prefer forward repair. Never reset durable reservation/Run evidence.
  Failure before publication leaves target untouched; after publication preserve
  raw diagnostics and exact readback, no blind retries, and use a fix PR.
- Forbidden: production publication/DB changes, force push, direct main push,
  existing Workspace/data/credential destructive actions. Private staging result
  is `/root/dev/takos/.operator-private/Takosumi-424-20261014/result.json`.
