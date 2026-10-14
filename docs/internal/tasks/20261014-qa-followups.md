# QA follow-ups for #447, #451/#452 and #454

- Owner/repository: Takosumi, `tako0614/takosumi` only; latest origin/main
  `a0f66df551f87ab6e70057ed9a42e45aaf9b1135`.
  Dedicated worktree `takosumi-qa-followups-20261014`, branch
  `fix/qa-followups-20261014`.
- Source docs: Japanese/English instructions explicitly state no grace
  window, immediate forge webhook secret update and manual sync recovery.
- Broken pending usage: count each invalid repair observation with a fixed
  reason in a structured log and counter; repeated retries count again.
  No intent, quantity, secret or tenant/Run identity is attached. Invalid
  intent still fails closed without billing or a completion marker.
- Accounts decision: at abandonment capacity, join the current initializer
  for at most 5 seconds, with at most 32 retained waiters per env/mode.
  Timeout/overflow retains 503/no-store/Retry-After. The existing three
  abandoned plus one current flight bound remains. No polling or autonomous
  retry; obsolete settlement only releases capacity for a later request.
  Structured count logs distinguish waiting, fulfillment, timeout and overflow.
- Verification: fake-time boundary, saturation/recovery and secret-free
  observation regressions; complete same-head
  `env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check`, with separate browser
  ports. Record exit, all phase/test counts and full head in Japanese ready PR.
- Delivery: normal push, QA request to 品質・リリース担当 by PR comment.
  Only matching full-head Approve permits head-matched squash merge.
  Then staging-only publication/tests under the existing exclusive lock
  `/root/dev/takos/.operator-private/takosumi-staging.stagingsync.lock`.
  Confirm staging Worker d87c97dc and staging-only config/credentials first.
- Reversal/failure: no schema/data migration or credential changes. Retain
  staging predecessor Version/artifact evidence; use the owner restore lane
  only with compatible state. Stop on publication/test failure, record whether
  target was touched, preserve diagnostics and do not blindly retry.
  No production, hosted #54, other worktrees/terminals/decks or force push.
