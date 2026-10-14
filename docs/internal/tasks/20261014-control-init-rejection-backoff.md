# Launch: Control init rejection backoff

- Owner/repository: Takosumi OSS; branch
  `fix/control-init-rejection-backoff-20261014`, baseline `c15f097fb`
  (includes #457/#459/#460).
- Problem: when the Control operations facade initializer rejects (e.g. a
  persistently failing substrate), `controlOperationsAttempt` evicts the
  attempt immediately, so every subsequent request re-runs `resolveOperations`.
  Under a sustained outage this is one initialization per request against the
  failing substrate. The Accounts handler layer already cools rejected
  initializations down (`retryAtMs`, #459); the Control facade layer did not.
  Refs #444 (staging reliability); this does not claim the 120s incident cause.
- Change: retain the rejected attempt for
  `CONTROL_OPERATIONS_INIT_FAILURE_BACKOFF_MS` (1s, same as the Accounts
  handler layer) and share the settled rejection with concurrent requests.
  They fail fast through the existing generic 503 (`controlPlaneUnavailable`,
  `no-store`, server-timing `tk_control_init` only, no store read, no secret
  leak). The entry is evicted lazily, so the first request after the window
  retries exactly once. No schema migration, no billing/price/entitlement/
  wallet change, no new I/O, polling, or autonomous retry.
- Verification: red-first route test (rejection storm coalesces to one
  resolver call + one warning; retry happens after the cooldown); updated the
  test that pinned immediate eviction to the cooldown contract; full
  `env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check` on isolated
  dashboard/docs ports. Record command, exit, counts and complete head in
  the PR.
- Release: ordinary push and ready Japanese PR; request 品質・リリース担当 QA.
  Merge only with the prescribed Approve comment matching the complete current
  PR head, using squash and match-head-commit. Publish merged main only to
  staging after verifying target/config and taking existing shared staging
  locks. Run staging provenance, HTTP/dashboard/docs probes. No production,
  keys, runner image release or unrelated worktree changes.
- Reversal/failure: code-only change needs no data rollback. Previous Worker
  version may serve again; reverting reopens the retry storm. Stop on failed
  publication/readback and distinguish pre/post mutation; do not blindly
  retry. Forward repair goes through a reviewed PR and fresh gate.
