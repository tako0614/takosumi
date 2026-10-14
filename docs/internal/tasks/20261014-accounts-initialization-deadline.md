# Bound the Accounts handler initialization wait

- Owner/repository: Takosumi only; branch
  `fix/accounts-init-deadline-20261014`.
- Base: `d527e8c22e0cf463313df21233de8d028541158f`.
- Tracking: PR #447; Refs #444; includes the 09:41 JST QA change requests.
- Scope: bound each Accounts-routed request's wait for the shared cold handler
  initialization to 5 seconds. On timeout, return a structured, cache-disabled
  503 with a short retry hint and safe stage/timing fields. Keep the identity
  and control initializer caches separate. A waiter timeout does not abort
  the initializer. Pending attempts are reused for up to 30 seconds; the
  first caller at or beyond that age replaces the cache entry synchronously,
  before any await, and concurrent callers share the one new current attempt.
  Failed attempts retain the existing 500 response during a one-second
  backoff measured from rejection; the next caller after backoff evicts the
  failure and starts one new attempt. Successful handlers remain cached.
  Cache eviction is request-driven, with no background retry/eviction timers.
  The cached initializer has one settlement observer; timed-out
  request waiters leave its Set, so repeated timeouts do not retain Promise
  reactions. Settlement of an obsolete attempt is observed but ignored;
  its remaining waiters leave at their own five-second deadlines. Platform
  fetch passes its execution context through to Accounts, which registers
  the shared settlement promise with `waitUntil` before waiting. Request-local
  verifier/workspace callbacks also pass that context through extension,
  Interface, catalog and MCP authentication to Accounts session/introspection
  and workspace reads.
- Evidence boundary: this is an independent availability fix justified by the
  pending schema-gate code path and a deterministic red test. The reported
  staging 120-second hang remains unlocated; the live GET probes were fast.
  This change does not claim to resolve that incident.
- Risk: a cold start that takes longer than five seconds returns 503 to that
  request while initialization continues. The D1 gate and handler build are
  not canceled when a waiter leaves or the cache entry is replaced; the D1
  binding exposes no cancellation mechanism. Thus old I/O can overlap a new
  current attempt, at most one replacement per 30-second pending window.
  In self-host bootstrap/local-fixture mode, existing idempotent DDL/seeding
  can also complete late; predeployed schema checks remain read-only.
  `waitUntil` extends post-response work for the runtime's bounded lifetime,
  not indefinitely; request-driven expiry recovers a retained pending attempt
  if that work is canceled. `Retry-After: 1` remains a short recovery hint,
  matching the failure backoff and permitting use of a handler that completes
  before the pending-attempt expiry.
- Delivery: this fix uses its own branch and PR. It is separate from the
  one-shot merged-main staging publication; the parent operator owns the
  exact-head gate, PR, and QA. This continuation permits normal push and a QA
  re-review request only; the merge watcher owns merge after its QA decision.
  No force-push, deploy, schema/data, production, or `takos1` changes are in
  scope.

## Verification

The focused test delays the real Accounts D1 schema-readiness gate, starts two
requests at different times, and advances Bun's fake clock. It checks each
waiter's independent deadline, generic response and timing/log fields, no
request body consumption or D1 writes after timeout, one shared initialization,
and a later successful use of the same handler after the schema gate resolves.
A second test checks that five sequential timeouts within the attempt's
30-second lifetime drain active waiters and a late schema rejection returns
the existing 500 during backoff without an unhandled rejection.
Both tests also leave a waiter active when the shared attempt settles, then
advance past its former deadline to verify its timer was canceled.

The original deadline test was run against the original implementation first: after advancing
the first request past five seconds, its response remained unsettled (**0
pass / 1 fail**, expected 503, received no response). After the fix, the same
focused test passes (**1 pass / 0 fail**).

After replacing the per-request `Promise.race` with removable waiters, both
focused cases passed (**2 pass / 0 fail**); the full Accounts Worker test file
passed (**24 pass / 0 fail**). `bun run check:worker-types`,
`bun run fmt:check`, and `git diff --check` passed. The repository-wide
`bun run check` remains the handoff gate.

## QA correction verification

Six new regressions were first run against PR head
`5565726204d85f269db7221b352e4c170f96bc06`: **0 pass / 6 fail**.
Each failed because D1 schema reads remained at one instead of starting a
second attempt. The final tests cover both identity and control caches:

- Pending at 29,999 ms still uses the original attempt; 12 concurrent callers
  at 30,000 ms start exactly one replacement. Old fulfillment and old rejection
  cannot dispatch the old waiter, settle the new flight, or poison the new
  successful cache. The obsolete waiter returns 503 at its own deadline;
  canceled timers do not emit extra timeout warnings, writes remain zero,
  and late rejection has no unhandled rejection.
- A rejected attempt is reused for concurrent callers through 999 ms;
  12 callers at 1,000 ms start exactly one fresh D1 read, then recover and
  continue to reuse the successful handler beyond the former age limit.
- The actual platform fetch, both on public identity and extension-session
  routes, registers the same shared initialization promise
  for two concurrent requests, allows late completion after their deadlines,
  and reuses the recovered handler without registering new background work.
  The public identity route returns bounded 503s; the unauthenticated extension
  route keeps its existing 401 response and never dispatches to the extension.

Independent review verified the pending/rejection cache lifecycle and the
live platform HTTP call graph. Its context-forwarding finding for in-process
authentication was addressed and re-reviewed with no remaining blocker.

Focused Accounts Worker tests: **32 pass / 0 fail**.
`env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check:worker-types` and
`git diff --check` passed. Run the canonical
`env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check` on the final commit
before normal push, and record its exact head, exit status, phase results,
and log digest on PR #447 when requesting QA re-review.
