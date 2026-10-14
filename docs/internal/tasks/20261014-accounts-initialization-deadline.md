# Bound the Accounts handler initialization wait

- Owner/repository: Takosumi only; branch
  `fix/accounts-init-deadline-20261014`.
- Base: `d527e8c22e0cf463313df21233de8d028541158f`.
- Tracking: Refs #444.
- Scope: bound each Accounts-routed request's wait for the shared cold handler
  initialization to 5 seconds. On timeout, return a structured, cache-disabled
  503 with a short retry hint and safe stage/timing fields. Keep the identity
  and control initializer caches separate. A waiter timeout does not abort,
  evict, replace, or duplicate the pending initializer; a later caller reuses
  its result. The cached initializer has one settlement observer; timed-out
  request waiters leave its Set, so repeated timeouts do not retain Promise
  reactions. Initialization rejection keeps the existing 500 behavior.
- Evidence boundary: this is an independent availability fix justified by the
  pending schema-gate code path and a deterministic red test. The reported
  staging 120-second hang remains unlocated; the live GET probes were fast.
  This change does not claim to resolve that incident.
- Risk: a cold start that takes longer than five seconds returns 503 to that
  request while initialization continues. The D1 gate and handler build are
  not canceled when a waiter leaves.
- Delivery: this fix uses its own branch and PR. It is separate from the
  one-shot merged-main staging publication; the parent operator owns the
  exact-head gate, PR, and QA. No schema/data, production, or `takos1`
  changes are in scope.

## Verification

The focused test delays the real Accounts D1 schema-readiness gate, starts two
requests at different times, and advances Bun's fake clock. It checks each
waiter's independent deadline, generic response and timing/log fields, no
request body consumption or D1 writes after timeout, one shared initialization,
and a later successful use of the same handler after the schema gate resolves.
A second test checks that 12 sequential timeouts drain active waiters and a
late schema rejection returns the existing 500 without an unhandled rejection.
Both tests also leave a waiter active when the shared attempt settles, then
advance past its former deadline to verify its timer was canceled.

The test was run against the original implementation first: after advancing
the first request past five seconds, its response remained unsettled (**0
pass / 1 fail**, expected 503, received no response). After the fix, the same
focused test passes (**1 pass / 0 fail**).

After replacing the per-request `Promise.race` with removable waiters, both
focused cases passed (**2 pass / 0 fail**); the full Accounts Worker test file
passed (**24 pass / 0 fail**). `bun run check:worker-types`,
`bun run fmt:check`, and `git diff --check` passed. The repository-wide
`bun run check` remains the handoff gate.
