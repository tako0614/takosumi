# Launch: immutable PostgreSQL usage settlement

- Owner/repository: Takosumi OSS; branch `feature/takosumi-launchnext-20261014`,
  baseline `a0f66df55` (includes #454).
- Problem: simultaneous recovery callers can both read a missing usage key.
  PostgreSQL's upsert then overwrites the winner and returns each caller's own
  proposed quantity/rating. A committed usage event must survive replay unchanged.
- Change: use the existing unique idempotency-key index to arbitrate an insert,
  preserve the entire winner, and return that stored event to losing callers.
  Read the winner in a subsequent statement so a concurrent PostgreSQL commit is
  visible. Database/primary-key failures remain failures, never fabricated success.
- Billing/storage authority: independent quality/release QA is required. No
  migration, backfill, historical rewrite, new billing key, price, entitlement,
  wallet, Hosted adapter, execution authority or provider change.
- Verification: deterministic concurrent writers over actual PostgreSQL SQL,
  sequential replay on a fresh store, storage parity, unrelated keys and failure
  propagation; full `env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check` on
  isolated dashboard/docs ports 27181/27182. Record command, exit, counts and
  complete head in the PR.
- Release: ordinary push and ready Japanese PR; request 品質・リリース担当 QA.
  Merge only with the prescribed Approve comment matching the complete current
  PR head, using squash and match-head-commit. Publish merged main only to staging
  Worker d87c97dc after verifying target/config and taking existing shared staging
  locks. Run staging provenance, HTTP/dashboard/docs and authenticated read probes.
  No production, keys, runner image release or unrelated worktree changes.
- Reversal/failure: code-only change needs no data rollback. Previous Worker
  version may serve again; reverting the self-host patch reopens the concurrency
  defect. Stop on failed publication/readback and distinguish pre/post mutation;
  do not blindly retry. Forward repair goes through a reviewed PR and fresh gate.
