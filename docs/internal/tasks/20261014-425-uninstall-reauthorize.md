# Issue #425 / TASK-0031 deadline uninstall reauthorization

- Owner: Takosumi only, branch `fix/uninstall-expiry-reauthorize-20261014`,
  baseline `63eb47c24ead54e2acd18e7f1f1f051103bcf116`. This task changes
  authorization and persisted JSON evidence; no sibling edits.
- Request authority: authenticated Accounts dispatch captures the stable
  account subject. Session requests persist account identity only; rotating or
  expiring a browser session does not revoke a durable human scheduling intent.
  PAT requests additionally pin the nonsecret PAT ID; OAuth requests pin the
  existing token-store SHA256 hash. Raw credentials are never persisted here.
  These references are internal and excluded from public Capsule projections.
- Deadline policy: Core re-reads canonical Workspace ownership/membership and
  requires the namespace owner or an active owner/admin. The host's Accounts
  port separately checks account existence and, for delegated requests, the
  exact current grant's subject, Workspace scope, write scope, expiry and
  revocation. An expired short-lived OAuth grant stops a seven-day reservation;
  a currently authorized user must cancel and schedule again.
- Revalidation runs before export/Plan, before automatic approval, after an
  awaited approval, at Apply admission and before provider dispatch. Run
  reconciliation after provider mutation remains able to record the outcome;
  revocation cannot undo a provider operation already dispatched.
- Missing legacy requester, missing host port, unavailable authority, removed
  or demoted membership and inactive grants fail closed. The request receives
  `blockedReason` and durable `authorizationRejectedAt`; Activity attempts record
  the system actor, original requester, timestamp and reason. Restored authority
  does not silently revive a blocked request. The owner can cancel only before
  any external lifecycle/provider mutation. If cleanup already ran, preserve
  its evidence and require authorized forward repair; it never authorizes a
  new provider destroy after the requester loses authority.
- Compatibility: existing Postgres/D1 Capsule JSON stores accept additive
  fields. Existing PAT IDs and access-token hash keys support indexed lookups.
  No DDL migration, backfill, credential rewrite or existing-record rewrite is
  required. Legacy reservations intentionally stop until an authorized user
  cancels/reschedules. Rolling back to older code reopens the authorization bug;
  use forward repair, or pause finalization before reverting. Staging first.
- Preserve uninstall ID/revision CAS, cancel/replacement fences, delete-only
  Plan verification and Workspace management admission. A blocked request also
  invalidates its old system approval at atomic Apply admission.
- Verification: focused lifecycle tests across memory/Postgres/D1, live
  Accounts grant tests and host composition; then
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26551 TAKOSUMI_DOCS_BROWSER_PORT=26552 bun run check`.
  Exact results and head SHA are recorded in the PR and private result artifact.
- Release: ready PR with `Closes #425`, ordinary push only, GHA green and explicit
  quality/release approval for the exact head; squash merge with match-head.
  User authorizes this task's staging publication after acquiring the shared
  stagingsync lock, overriding older handoff-only task notes. No production
  target, database, existing user resource or credential may be changed.
- Staging: verify target/config before every deploy command, record previous
  version, commit/artifact provenance and authoritative post-readback. Use fresh
  providerless fixtures in the authorized test Workspace. Failures before/after
  publication must be distinguished; no blind retry. Forward repair requires a
  reviewed fix PR and repeat staging tests.
