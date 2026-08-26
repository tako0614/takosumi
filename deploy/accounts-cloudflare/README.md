# Takosumi Accounts — in-process source module

This directory is **not a standalone deployable Worker anymore**. It is the
Cloudflare reference entry point for the account-plane handler
(session cookie, upstream sign-in, OIDC issuer/client registration, dashboard
account-plane facade, Interface OAuth, and any
Cloud-only billing hooks supplied by the host composition), consumed in-process
by the operator Takosumi platform worker:

- the operator Takosumi platform worker in `takosumi/deploy/platform/`, served at
  the operator's explicit origin (`app.takosumi.com` for official Cloud).

The self-hosted Takos product worker template in `takos/deploy/cloudflare/` is an
external OIDC/control-plane client. It does not mount this handler.

The former standalone account-plane Worker scaffold (its `wrangler.toml`,
`src/worker.ts` entrypoint, and the `render-config` /
`validate-rendered-config` / `probe` / `ensure-dns` / `spa-api-split-e2e` deploy
scripts) has been removed. Real operator deploy configuration and secrets live
outside this repo in the operator environment.

The platform worker references this module through the
`@takosjp/takosumi-accounts-worker` tsconfig alias, which points at
`src/handler.ts`. The host worker supplies the actual mount, bindings, secrets,
custom-domain route, and deploy command.

Static downstream clients are configured with the non-secret JSON array
`TAKOSUMI_ACCOUNTS_CLIENTS`. A Takos native client entry uses a unique client id
per Takos host, the exact `takos://oauth/callback` redirect,
`tokenEndpointAuthMethod: "none"`, and an explicit `allowedScopes` array. The
Takos Worker advertises the same id through `OIDC_MOBILE_CLIENT_ID`; the mobile
app never carries a client secret.

Accounts is a backing layer, not a second control plane. Product control-plane
resources (Workspaces, Projects, Capsules, Sources, ProviderConnections,
CredentialRecipes, ProviderBindings, Secrets, Runs, StateVersions, Outputs,
Runners, and AuditEvents) are created and read through `/api/v1/*`. The current
Accounts does not own a Capsule/runtime projection or a second Run/Output
ledger. Its session-authenticated control routes are a facade over the same
canonical operations used by the control plane. Runtime discovery and grants
are canonical `Interface` / `InterfaceBinding` records; standard OpenTofu
Outputs are referenced only through explicit Interface input mappings.

## Files

- `src/handler.ts` — env parsing, D1 store construction, and cached Accounts
  handler construction. Exports `createCloudflareWorker`, consumed in-process by
  the host worker.
- `src/routes.ts` — `isAccountsApiPath` / `isWorkerLocalPath` / `ACCOUNTS_API_PREFIXES`
  path classification (also mirrored by `deploy/node-postgres/src/static-assets.ts`).
- `src/routes_test.ts`, `src/worker_test.ts` — coverage for the kept
  handler/routes logic (path classification, issuer policy, fail-closed, and
  IPv6/CGNAT handling).

## Routing shape

The handler keeps `/healthz` and `/readyz` as edge-local routes. Every account-plane path is handled directly by
`createEphemeralAccountsHandler` (or `createAccountsHandler` when a stable ES256
JWK is configured) with a `D1AccountsStore`. The default `bootstrap` mode
initializes the D1 schema lazily and idempotently before the first account-plane
handler is built. A hosted operator that runs the reviewed migration lane before
promotion can set `TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE=predeployed`; that mode keeps
all schema DDL off the request/cold-start path and performs only the strict
read-only schema-version check. A missing table or version fails closed.
Control-plane state, Outputs, backups, and source transport remain owned by the
canonical Takosumi control plane rather than Accounts storage.

## D1 schema migration

`accounts/service/src/d1-migrations.ts` is the sole Accounts D1 catalog. The
CLI, Worker gate, and local substrate consume the same ordered v0-v4 names and
checksums. The current Worker gate accepts only the exact checksummed v4
closure. Exact legacy v3, missing rows, gaps, name or checksum drift, partial
`ALTER`, older/newer heads, missing owned tables or indexes, and an incomplete
v4 activation-digest backfill all fail closed. The preceding reviewed feature
bridge accepted exact legacy v3 or exact v4 only for the one-time migration
window and remains the compatible rollback floor.

During that bridge window, the owner CLI inventories Capsule-bound OIDC clients
in deterministic `key` chunks of at most 100 and performs one guarded,
restart-safe update per chunk in the same atomic batch as an exact-v3
ledger/schema fence. It reconciles a lost acknowledgement read-only, adopts
only an exact clean v4 after fence loss, never writes after a drifted/missing
v4 cutoff, never prints keys/documents, and requires a global zero-missing
result. The v4 migration is one D1 batch transaction: its first statement
re-fences the exact v0-v3 legacy names, canonical `sqlite_master` closure, and
zero-missing, then it adds the
nullable `checksum` column, backfills the immutable v0-v3 checksums, and inserts
the v4 receipt. A concurrent same-catalog runner is reconciled by the exact
receipt; a conflicting or partial result is indeterminate and is never retried
blindly.

Hosted operation is a one-time bridge sequence:

1. deploy the reviewed v3/v4-compatible bridge predecessor while the protected database is exact v3;
2. obtain and privately retain backup/Time Travel evidence outside source
   checkouts, bind its opaque digest to the plan configuration confirmation;
3. run bounded pre-ledger backfill, apply atomic v4, and read-only verify it;
4. after the observation window, deploy this current exact-v4-only artifact.

Before constructing any plan or reading a token, the owner CLI uses reviewed
Git configuration to require that the real checkout top-level is the owning
Takosumi root, its observed HEAD equals `--source-commit`, and tracked plus
untracked status is empty. Ambient Git repository/config/fsmonitor authority is
excluded. Local substrate renders the Accounts-owned runtime beside the catalog
and authenticates the exact policy/schema closures before using that same
bounded backfill algorithm against its persisted D1.

After v4 commits, a v3-only artifact is past the rollback cutoff. Roll back code
only to the bridge (or roll forward); Time Travel restore remains a separate
incident authority and is never invoked by the migration CLI.

`predeployed` performs only the strict catalog/schema reads and zero
request-time DDL. `bootstrap` may initialize the base store, but it does not
advance the migration ledger; the current Worker still requires exact v4 before
serving traffic. Gate diagnostics contain only digests and issue codes, never
rows, SQL values, tokens, or target IDs.
