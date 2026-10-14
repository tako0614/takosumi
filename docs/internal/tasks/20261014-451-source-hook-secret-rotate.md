# Issue #451: Source webhook hookSecret rotation

- Owner/repository: Takosumi担当-hookrotate, `tako0614/takosumi` only.
- Baseline: `00bed4188abd8b6d03f3a1115f96bf7903caf74b` (`origin/main` at branch creation).
- Worktree: `/root/dev/takos/.worktrees/takosumi-hooksecret-rotate-20261014`;
  branch `feature/source-hooksecret-rotate-20261014`.
- Problem: Source creation returns a webhook bearer once and stores only its
  hash. PATCH deliberately cannot update that hash; leakage or loss has no
  in-place recovery operation.
- Contract: `POST /api/v1/sources/{sourceId}/hook-secret/rotate`, matching
  internal seam and contract path helper, no request body. Source update
  authority is required. The server generates 32 random bytes, stores SHA-256
  only, and returns `{source, hookSecret}` once with `Cache-Control: no-store`.
- Authority: exact Source compare-and-swap and captured active Workspace epoch;
  update and value-free `source.hook_secret_rotated` Activity commit atomically.
  No grace period. Authentication after commit rejects the former bearer;
  previously authenticated requests and queued Runs are not cancelled.
- Concurrency/retry: one competing CAS wins; others return 409 without a secret.
  Fresh POSTs each rotate again. No plaintext cache/replay or automatic retry;
  a lost response requires an explicit fresh rotation. Stale PATCH or sync
  writes must never restore an old hash.
- Scope: contract, Source service/facades, Accounts/internal routes, OpenAPI,
  memory/PostgreSQL/D1 stores, regression tests, ja/en documentation. API-only
  incident recovery; no dashboard UI or persisted-schema migration.
- Verification: regression red before implementation; focused store/service/API
  and webhook tests; independent review; full `env -u NODE_ENV -u
  TAKOSUMI_ENVIRONMENT bun run check` on final committed head with isolated ports.
  Complete phase results and log SHA-256 belong in the PR and private evidence.
- Delivery: Issue #451 -> normal push -> ready PR -> formal QA request comment
  with the full final head SHA. Evidence is recorded outside Git under the
  operator-private task directory, ending in `result.json`.
- Prohibited: merge, deploy, staging publication, production access, force-push,
  any existing Source secret mutation, takos1 interference, new deck creation,
  and modifications to other worktrees.
