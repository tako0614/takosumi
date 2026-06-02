# Takosumi Accounts — Cloudflare Worker reference

Reference Cloudflare deployment scaffold for Takosumi Accounts. Operators can use it for hostnames such as `https://accounts.takosumi.com/` after recording live DNS, route, D1/R2 binding, secret, and health evidence. The scaffold is **Worker-only**: the Worker runs `createAccountsHandler` directly with a `D1AccountsStore` and an R2-backed metadata export worker, so OIDC discovery, OAuth, passkeys, Stripe webhooks, install dry-run/apply/import/export, dashboard, launch tokens, and personal access token routes all live in one edge process.

## Files

- `wrangler.toml` — Worker config, D1 binding, R2 export-artifact binding, and custom-domain route template for `accounts.takosumi.com`. Wrangler runs a Bun custom build and uploads the bundled Worker without a second esbuild pass.
- `src/worker.ts` — Worker entrypoint.
- `src/handler.ts` — env parsing, D1 store construction, cached Accounts handler construction.

## One-time operator setup

1. **Cloudflare account / zone**. Add `takosumi.com` as a zone in Cloudflare. Ensure the operator credential can upload Workers, attach the Worker route / custom domain, and manage the D1 database plus R2 export bucket. This scaffold does not require KV, Pages, Durable Object, or Container permissions unless you add those bindings yourself.
2. **Create the D1 database**:
   ```sh
   wrangler d1 create takosumi-accounts
   ```
   Keep the returned UUID in the operator environment as `TAKOSUMI_ACCOUNTS_D1_DATABASE_ID`. Do not edit the tracked `wrangler.toml`; render an ignored deploy config instead:
   ```sh
   TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid> \
   TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host> \
    bun run deploy:accounts-cloudflare:render-config
   ```
3. **Create the R2 export bucket**:
   ```sh
   wrangler r2 bucket create takosumi-accounts-exports
   ```
   The Worker stores metadata-only AppInstallation export artifacts in this bucket and serves signed same-origin download URLs from `/__takosumi/exports/...`.
4. **Push secrets** (one-time, run from `takosumi/` root):
   ```sh
   wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK \
     --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
   wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET \
     --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
   wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET \
     --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
   wrangler secret put TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET \
     --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
   wrangler secret put TAKOSUMI_ACCOUNTS_INSTALLER_TOKEN \
     --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
   ```
   Add Stripe (`TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY`, `TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET`), passkey (`TAKOSUMI_ACCOUNTS_PASSKEY_*`), upstream OIDC (`TAKOSUMI_ACCOUNTS_UPSTREAM_*`), and OIDC client secret (`TAKOSUMI_ACCOUNTS_CLIENT_SECRET`) only if you need those features.
5. **Attach the custom domain** in the Cloudflare dashboard:
   - Workers & Pages → `takosumi-accounts` → Triggers → Custom Domains → `accounts.takosumi.com`.
   - The `[[routes]]` block in `wrangler.toml` ensures the worker accepts requests at that hostname. Treat DNS/TLS as accepted evidence only after `deploy:accounts-cloudflare:ensure-dns -- --check --fail-on-not-ready` and `deploy:accounts-cloudflare:probe -- --fail-on-not-ready` pass.
6. **Re-render when installer or route settings change**. The Accounts Worker proxies install dry-run/apply to the Takosumi installer and must know that base URL before Store / dashboard install controls can work:
   ```sh
   export TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host>
   bun run deploy:accounts-cloudflare:render-config
   ```

## Routing shape

The Worker keeps `/healthz` and signed `/__takosumi/exports/...` downloads as edge-local routes. Every account-plane path is handled directly by `createEphemeralAccountsHandler` (or `createAccountsHandler` when a stable ES256 JWK is configured) with a `D1AccountsStore`. The D1 schema is initialized lazily and idempotently by the Worker before the first account-plane handler is built. Export requests write a metadata JSON bundle to R2 and return a signed same-origin download URL. Data-bearing or encrypted archive exports still need a substrate export worker outside this edge scaffold.

## Deploy

From `takosumi/` root:

```sh
TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid> \
TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host> \
  bun run deploy:accounts-cloudflare:render-config
bun run deploy:accounts-cloudflare:dryrun   # validates bindings + env without uploading
bun run deploy:accounts-cloudflare          # uploads the worker
```

Both deploy tasks first run `deploy:accounts-cloudflare:validate-config`, then use the ignored rendered config at `deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml`. The validation rejects placeholder D1 UUIDs, example/test installer URLs, missing D1/R2 bindings, and any Container or Durable Object persistence block. Its JSON includes a `configDigest` and boolean D1/R2/Worker-only checks so the rendered config can be referenced from private topology evidence without exposing the raw D1 database UUID. For the real D1 database, render it first:

```sh
TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid> \
TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host> \
  bun run deploy:accounts-cloudflare:render-config
bun run deploy:accounts-cloudflare:dryrun
bun run deploy:accounts-cloudflare
```

For a closed Workers.dev bootstrap before the custom domain exists, render the same config with the route removed and `workers_dev = true`:

```sh
TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid> \
TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host> \
  bun run deploy:accounts-cloudflare:render-config -- --workers-dev
bun run deploy:accounts-cloudflare
```

When attaching the custom-domain route before DNS is fixed, keep Workers.dev enabled so the bootstrap endpoint remains probeable:

```sh
TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid> \
TAKOSUMI_ACCOUNTS_INSTALLER_URL=https://<takosumi-installer-host> \
  bun run deploy:accounts-cloudflare:render-config -- --workers-dev-with-routes
bun run deploy:accounts-cloudflare
```

If `accounts.takosumi.com` still does not resolve after the route deploy, create a proxied DNS record for `cloud` in the `takosumi.com` zone with an operator credential that has zone DNS permission, or attach the Worker as a Cloudflare Custom Domain from the dashboard. The Wrangler OAuth token used for Worker/D1/R2 deploys may be sufficient for route attachment while still lacking zone DNS permissions.

The DNS record plan is machine-readable:

```sh
export TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME=<worker-subdomain>.workers.dev
export TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL="https://${TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME}"

bun run deploy:accounts-cloudflare:ensure-dns
```

With an operator token that has zone DNS permission, check or apply the proxied CNAME:

```sh
CLOUDFLARE_API_TOKEN=<zone-dns-token> \
  bun run deploy:accounts-cloudflare:ensure-dns -- --check
CLOUDFLARE_API_TOKEN=<zone-dns-token> \
  bun run deploy:accounts-cloudflare:ensure-dns -- --check --fail-on-not-ready
CLOUDFLARE_API_TOKEN=<zone-dns-token> \
  bun run deploy:accounts-cloudflare:ensure-dns -- --apply
```

The intended record is a proxied `CNAME` from `accounts.takosumi.com` to the Accounts Workers.dev hostname. The script emits `takosumi.cloudflare-dns-record-plan@v1` JSON and never prints the token, Cloudflare zone ID, or DNS record ID. The target hostname is required through `--target`, `TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME`, or `TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL`; there is no source-controlled default Workers.dev hostname. DNS check/apply reports also include whether the Cloudflare API base URL is the live default, so fake API test output cannot be mistaken for live DNS evidence. `--check` reports `ok:false` with `action:"create"` or `action:"update"` until the live Cloudflare record already matches the planned CNAME. If Cloudflare returns a DNS permission failure, the report includes `permissionHint` with the required Zone DNS read/edit permission and the expected token environment variable. `--apply` refuses to create or update the record when the initial DNS lookup fails, because it cannot know whether the correct action is create or update without current DNS state. Add `--fail-on-not-ready` only when using the DNS check as a CI/evidence gate; without it, `--check` is a read-only status report.

Smoke check after deploy:

```sh
curl https://accounts.takosumi.com/healthz
curl https://accounts.takosumi.com/.well-known/openid-configuration
```

The OIDC discovery response should show `"issuer": "https://accounts.takosumi.com"`.

Use the checked probe when collecting operator evidence:

```sh
bun run deploy:accounts-cloudflare:probe -- \
  --workers-dev-url "$TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL" \
  --custom-domain-url https://accounts.takosumi.com \
  --expected-issuer https://accounts.takosumi.com \
  --fail-on-not-ready
```

The probe emits `takosumi.cloudflare-accounts-probe@v1` JSON with separate Workers.dev and custom-domain results. It reports `readyForLaunch:false` until the custom domain resolves, `/healthz` returns `persistence:"d1+r2"`, and OIDC discovery returns the expected issuer. Drop `--fail-on-not-ready` only when using the command as a read-only status report that may record blocked custom-domain evidence without failing the shell command. `takos-private` `managed-offering:status` reads the same `TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL` environment variable when it renders topology evidence commands.

## Production env vars

- `TAKOSUMI_ACCOUNTS_ISSUER` — `https://accounts.takosumi.com` (canonical issuer)
- `TAKOSUMI_ACCOUNTS_CLIENT_ID` — primary OIDC client (`takos-private-production`)
- `TAKOSUMI_ACCOUNTS_REDIRECT_URIS` — comma-separated allow-list (currently `https://takos.jp/auth/oidc/callback`)
- `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS` — `closed` until managed-offering readiness evidence is filed. Opening access requires `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST` plus the evidence / approval / public-summary refs produced by the final live audit. For Worker deploys, map the audit output's `accountsServeManagedOfferingArgs` to `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST`, `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_EVIDENCE_REF`, `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_APPROVAL_REF`, and `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_PUBLIC_SUMMARY`; do not hand-create alternate values.
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS` — signed R2 export download URL TTL in milliseconds. Defaults to 24 hours when omitted.
- `TAKOSUMI_ACCOUNTS_INSTALLER_URL` — Takosumi installer base URL used by the Accounts Worker install dry-run/apply proxy. `deploy:accounts-cloudflare:render-config` requires this value for real deploy configs.
- `TAKOSUMI_ACCOUNTS_INSTALLER_TOKEN` — optional bearer secret for the installer proxy. Set it with `wrangler secret put`; do not commit it to wrangler config.

No container runtime package, Durable Object container binding, Dockerfile, or container migration is used by this scaffold — the Accounts handler runs entirely in the V8 isolate against D1, with R2 used only for export artifacts. The "no Queue, no DO" stance applies specifically to the Cloudflare-side mirror of the service-Worker boundary that this distribution implements: Accounts identity, billing, and AppInstallation ledger persistence land in D1, edge export artifacts land in R2, and that is the entire set of Cloudflare runtime primitives used by this account-plane mirror. The takosumi service itself runs in a separate process (and may live on a substrate that uses queues or Durable Objects); service-side substrate choices are scoped to the service deployment, not to this Accounts Worker.

## D1 schema migration

The Cloudflare Worker refuses to serve account-plane traffic when the D1 database it is bound to reports a `takosumi_accounts_schema_migrations.version` that drifts from the version this Worker expects. A `takosumi_accounts_schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)` bookkeeping table is created on first contact, but the Worker never advances the recorded version itself — that is the migration runner's job. The Worker reads only `version` from this table; the table name and column shape are identical to the table the `accounts migrate-d1` runner writes (`D1_SCHEMA_MIGRATIONS_TABLE_SQL` in `packages/cli/src/cli-accounts-db.ts`), so a `migrate-d1` run is visible to this gate. The version check fails fast with a clear pointer back to this section so operators don't unknowingly run a service against a stale schema.

- A brand-new D1 database (no `takosumi_accounts_schema_migrations` rows) is treated as the baseline (version 0) and matches the version this Worker ships with today. The initial table layout is created by `D1AccountsStore.initialize()` via `D1_ACCOUNTS_STORE_INIT_SQL`. The `migrate-d1` runner records that same baseline as version 0, so running it on a fresh database does not trip the gate.
- When a real migration is added in `@takosjp/takosumi-accounts-service`, the Worker constant `EXPECTED_D1_SCHEMA_VERSION` and a new `D1_ACCOUNTS_MIGRATIONS` entry (version 1, 2, …) are bumped together. The Worker refuses to start serving the account plane until the migration runner has recorded the matching `(version, name, applied_at)` row in `takosumi_accounts_schema_migrations`.
- Do not run `migrate-d1` concurrently against the same D1 database. There is no advisory lock (D1's stateless HTTP `execute` cannot hold one); a racing second runner fails loud on the `version` PRIMARY KEY. Run it from a single deploy job.
- Run the migration runner before a new deploy that bumps the expected version:

  ```sh
  bun run cli -- accounts migrate-d1 \
    --config deploy/accounts-cloudflare/.wrangler/takosumi-accounts.deploy.toml
  ```

- A drifted D1 raises a `worker_configuration_error` with the message `D1 schema version <recorded> is behind this Worker (expected <expected>); run ... migration runner before serving account-plane traffic`. The Worker also logs the same message via `console.error` so it surfaces in Cloudflare logs without exposing tenant data.
- If the Worker is older than the database (recorded version > expected version), the Worker refuses for the same reason — roll the Worker forward or roll the migration back to keep the schema and code in lockstep.

The schema version is verified once per Worker isolate (cached alongside the handler). Operators should expect a single `SELECT version FROM takosumi_accounts_schema_migrations ORDER BY version DESC LIMIT 1` query per cold start.

## Deploy profiles (`--env`)

`wrangler.toml` keeps a shared default block at the top of the file and adds explicit `[env.production]`, `[env.staging]`, and `[env.local]` sections that override `name`, `routes`, and `vars` per profile. Use the matching `--env` flag when invoking wrangler and the matching `--env` flag with `deploy:accounts-cloudflare:render-config`:

- `bun run deploy:accounts-cloudflare:render-config -- --env production` (default) — strict validation; every production-facing `[vars]` key must be non-empty and non-placeholder before the rendered config is written.
- `bun run deploy:accounts-cloudflare:render-config -- --env staging` — same strict checks; the rendered config targets the staging Worker name + zone-mirrored hostname (`accounts-staging.takosumi.com`).
- `bun run deploy:accounts-cloudflare:render-config -- --env local` — lenient; accepts `workers_dev` defaults and lets `wrangler dev --env local` run against the local substrate stack without operator secrets.

`deploy:accounts-cloudflare:validate-config` also asserts that the rendered `[vars]` block contains every required production-facing key (`TAKOSUMI_ACCOUNTS_ISSUER`, `TAKOSUMI_ACCOUNTS_CLIENT_ID`, `TAKOSUMI_ACCOUNTS_REDIRECT_URIS`, `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS`, `TAKOSUMI_ACCOUNTS_INSTALLER_URL`) so an operator hand-edit that removes one cannot reach production.
