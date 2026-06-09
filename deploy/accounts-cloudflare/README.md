# Takosumi Accounts — in-process source module

This directory is **not a standalone deployable Worker anymore**. It is the
Cloudflare reference entry point for the account-plane handler
(OIDC issuer / dashboard API / Installation ledger / billing), consumed
in-process by two build targets:

- the operator Takosumi platform worker in `takosumi/deploy/platform/`, served at
  `app.takosumi.com`;
- the self-hosted Takos product worker template in `takos/deploy/cloudflare/`,
  served at the self-hoster's own origin.

The former standalone account-plane Worker scaffold (its `wrangler.toml`,
`src/worker.ts` entrypoint, and the `render-config` /
`validate-rendered-config` / `probe` / `ensure-dns` / `spa-api-split-e2e` deploy
scripts) has been removed. Real operator deploy configuration and secrets live
outside this repo in the operator environment.

Both host workers reference this module through the
`@takosjp/takosumi-accounts-worker` tsconfig alias, which points at
`src/handler.ts`. The host worker supplies the actual mount, bindings, secrets,
custom-domain route, and deploy command.

## Files

- `src/handler.ts` — env parsing, D1 store construction, cached Accounts handler
  construction, signed R2 metadata-export worker. Exports `createCloudflareWorker`
  (consumed in-process by the Takos mount) and `createR2InstallationExportWorker`.
- `src/routes.ts` — `isAccountsApiPath` / `isWorkerLocalPath` / `ACCOUNTS_API_PREFIXES`
  path classification (also mirrored by `deploy/node-postgres/src/static-assets.ts`).
- `src/routes_test.ts`, `src/worker_test.ts` — coverage for the kept handler/routes
  logic (path classification, issuer policy, fail-closed, IPv6/CGNAT, R2 route-level
  signed export).

## Routing shape

The handler keeps `/healthz` and signed `/__takosumi/exports/...` downloads as
edge-local routes. Every account-plane path is handled directly by
`createEphemeralAccountsHandler` (or `createAccountsHandler` when a stable ES256
JWK is configured) with a `D1AccountsStore`. The D1 schema is initialized lazily
and idempotently before the first account-plane handler is built. Export requests
write a metadata JSON bundle to R2 and return a signed same-origin download URL.

## D1 schema migration

The handler refuses to serve account-plane traffic when the D1 database it is
bound to reports a `takosumi_accounts_schema_migrations.version` that drifts from
the version this code expects. A
`takosumi_accounts_schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`
bookkeeping table is created on first contact, but the handler never advances the
recorded version itself — that is the migration runner's job. The handler reads
only `version` from this table; the table name and column shape are identical to
the table the `accounts migrate-d1` runner writes
(`D1_SCHEMA_MIGRATIONS_TABLE_SQL` in `packages/cli/src/cli-accounts-db.ts`), so a
`migrate-d1` run is visible to this gate.

- A brand-new D1 database (no `takosumi_accounts_schema_migrations` rows) is the
  baseline (version 0). The initial table layout is created by
  `D1AccountsStore.initialize()` via `D1_ACCOUNTS_STORE_INIT_SQL`. The `migrate-d1`
  runner records the same baseline as version 0, so running it on a fresh database
  does not trip the gate.
- When a real migration is added in `@takosjp/takosumi-accounts-service`, the
  constant `EXPECTED_D1_SCHEMA_VERSION` and a new `D1_ACCOUNTS_MIGRATIONS` entry
  (version 1, 2, …) are bumped together. The handler refuses to serve the account
  plane until the migration runner has recorded the matching
  `(version, name, applied_at)` row.
- Do not run `migrate-d1` concurrently against the same D1 database. There is no
  advisory lock; a racing second runner fails loud on the `version` PRIMARY KEY.
  Run it from a single deploy job.
- A drifted D1 raises a `worker_configuration_error`
  (`D1 schema version <recorded> is behind this Worker (expected <expected>); run ... migration runner before serving account-plane traffic`),
  also logged via `console.error` without exposing tenant data. If the code is
  older than the database (recorded version > expected version), it refuses for the
  same reason — roll forward or roll the migration back to keep schema and code in
  lockstep.

The schema version is verified once per isolate (cached alongside the handler).
Expect a single
`SELECT version FROM takosumi_accounts_schema_migrations ORDER BY version DESC LIMIT 1`
query per cold start.
