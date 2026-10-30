# Configuration reference

Environment variables for the operator running a Takosumi endpoint. On the
Cloudflare deployment they go in `[vars]` or `wrangler secret put`; on the
Bun + PostgreSQL deployment they are process environment variables. Setup
steps live in [Running it yourself](../concepts/self-host.md).

Secret values are marked **secret** in the Required column. Do not write them
in config files; pass them from a secret store.

## Service-wide

| Variable                        | Required                                                    | Default | What it controls                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TAKOSUMI_ENVIRONMENT`          | Optional                                                    | `local` | One of `local` / `development` / `test` / `staging` / `production`. On `staging` and `production` the checks on encryption keys and persistent stores become fail-closed. `NODE_ENV` and `ENVIRONMENT` are read in the same order |
| `TAKOSUMI_DEV_MODE`             | Optional                                                    | unset   | Set to `1` / `true` / `yes` / `on` / `enabled` to boot without encryption keys outside production. Has no effect on `staging` and `production`                                                             |
| `PORT`                          | Optional                                                    | `8788`  | Listen port when started with `bun core/index.ts`                                                                                                                                                                |
| `TAKOSUMI_DATABASE_URL`         | Required when running the control plane standalone via `bun core/index.ts` | none    | PostgreSQL connection for the control plane. `DATABASE_URL` is read for the same purpose. The bundled Docker Compose definition runs the control plane and accounts on one connection, so there you set only `TAKOSUMI_ACCOUNTS_DATABASE_URL` |
| `TAKOSUMI_DB_AUTO_MIGRATE`      | Optional                                                    | `false` | Whether `bun core/index.ts` applies migrations at startup. By default it only verifies them read-only. Setting `true` on `staging` or `production` fails startup                                             |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | Required in real deployments, **secret**                    | none    | Bearer for the operator-only API (`/internal/v1/*`, the root `/capabilities` and `/openapi.json`, and the Interface operator path). It acts on every Workspace and is not accepted on the general public `/api/v1` routes. **Never give it to users, and do not use it for ordinary CLI calls.** Use it only on the operator's machine for operator-only work. Does not affect the retired Resource/Form `/v1` surface. The CLI's variable of the same name is described in [What the CLI reads](#what-the-cli-reads) |
| `TAKOSUMI_METRICS_SCRAPE_TOKEN` | Optional, **secret**                                        | none    | Bearer required to read `/metrics`. While unset, `/metrics` returns `404`                                                                                                                                    |

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL="postgres://takosumi:<password>@db.example.com:5432/takosumi"
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(openssl rand -hex 32)"
```

## Protecting secrets

| Variable                                      | Required                                                       | Default             | What it controls                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE`            | Required on `staging` / `production`, **secret**             | none                | Source of the AES-GCM key sealing ProviderConnections, state, and plans. Must be at least 32 bytes in UTF-8. `TAKOSUMI_SECRET_STORE_KEY` is read for the same purpose |
| `TAKOSUMI_SECRET_STORE_PARTITION_PASSPHRASES` | Optional, **secret**                                           | none                | JSON map of `partition name → passphrase` when partitions need separate keys. When omitted, every partition derives from the key above         |
| `TAKOSUMI_DATABASE_ENCRYPTION_AT_REST`        | Required when using `bun core/index.ts` on `staging` / `production` | none                | Declares that encryption at rest has been verified. The only accepted value is `verified`                                                    |
| `TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE`       | Optional                                                       | `operator-attested` | Non-secret string recording how the verification was done                                                                                      |

```bash
export TAKOSUMI_SECRET_STORE_PASSPHRASE="$(openssl rand -base64 48)"
export TAKOSUMI_DATABASE_ENCRYPTION_AT_REST=verified
export TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE="rds-storage-encrypted-kms-key-abc123"
```

Encryption at rest is judged only from the declared evidence, never guessed
from the shape of the connection string. A control plane started with
`bun core/index.ts` requires this declaration on `staging` and `production`.
Evidence on the storage adapter side also satisfies it.

## Sign-in and OIDC

accounts is the OIDC issuer itself. The issuer set here becomes the entrypoint
for the dashboard and for products signing in through Takosumi.

| Variable                                                                                                     | Required                                 | Default                                              | What it controls                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TAKOSUMI_ACCOUNTS_ISSUER`                                                                                   | Required on the Cloudflare deployment    | `http://localhost:<port>` on the PostgreSQL deployment | The public issuer URL. The Cloudflare deployment does not infer it from the request URL and refuses to boot while unset                                            |
| `TAKOSUMI_ACCOUNTS_DATABASE_URL`                                                                             | Required on the PostgreSQL deployment    | none                                                 | PostgreSQL connection for accounts. `takosumi accounts migrate` reads this too                                                                                   |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`                                                                        | Required when the issuer is https, **secret** | none                                                 | P-256 JWK signing id_tokens; contains the private `d`. Unset means the key changes per process, so restarts and extra replicas break verification                  |
| `TAKOSUMI_ACCOUNTS_ES256_KEY_ID`                                                                             | Optional                                 | the JWK's `kid`                                      | Key ID published in JWKS. When the JWK has no `kid` either, a fixed per-distribution value is used                                                                 |
| `TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS`                                                               | Optional                                 | none                                                 | Previous public JWKS published alongside the current key during rotation. Do not include the private `d`                                                           |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`                                                             | Required once a signing key is set, **secret** | none                                                 | Secret deriving the per-client subject. Setting only the signing key without this fails startup                                                                    |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`                                                                         | Required, **secret**                     | none                                                 | Salt for hashing session IDs at rest. The Cloudflare deployment refuses to boot without it; Bun refuses when `NODE_ENV=production` or `TAKOSUMI_ENV=production`    |
| `TAKOSUMI_ACCOUNTS_CLIENTS`                                                                                  | Optional                                 | none                                                 | JSON array of statically registered OIDC clients. `clientId` and `redirectUris` are required; `tokenEndpointAuthMethod` and `allowedScopes` may be attached      |
| `TAKOSUMI_ACCOUNTS_CLIENT_ID` / `TAKOSUMI_ACCOUNTS_REDIRECT_URIS`                                            | Optional                                 | none                                                 | Short form for registering a single client. Set both together                                                                                                      |
| `TAKOSUMI_ACCOUNTS_CLIENT_SECRET`                                                                            | Optional, **secret**                     | none                                                 | Secret making the client above a confidential client. Leave empty for a PKCE-only public client                                                                    |
| `TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD`                                                                       | Optional                                 | `client_secret_post` when a secret exists, else `none` | One of `client_secret_basic` / `client_secret_post` / `none`                                                                                                     |
| `TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES`                                                                           | Optional                                 | none                                                 | Comma-separated scopes allowed for the client above                                                                                                                |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`                                                                       | Optional                                 | none                                                 | JSON array of upstream OAuth / OIDC provider descriptors. Holds the **variable names** of the endpoint, client id, and secret — not the values                     |
| `TAKOSUMI_ACCOUNTS_SUBJECT_SECRET`                                                                           | Required when upstream providers are set, **secret** | none                                                 | Hash secret mapping upstream subjects onto Takosumi subjects                                                                                                       |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS`                                                                  | Optional                                 | none                                                 | Lifetime in milliseconds of sessions created by upstream sign-in. Set together with the upstream provider                                                          |
| `TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID` / `TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME` / `TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN` | Optional                                 | none                                                 | Relying party for passkeys. Startup fails unless all three are set. The PostgreSQL deployment also reads the origin from `TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN`       |
| `TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN`                                                                 | Optional, **secret**                     | none                                                 | Operator token recording completion of privacy requests                                                                                                            |
| `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` | Optional | none (no app may delegate) | Source repositories and allowed refs whose installed app may use its own OAuth token to act for its user. Only tokens of the app's current owner delegate (members are added without their consent, so their tokens never do). The user's app role alone reaches only apps that this delegate installed; every other app keeps the Workspace restriction and membership intersection. JSON array of `{"url":"https://…","path":".","refs":["refs/heads/main","refs/tags/v*"]}`; `refs` is required (`refs/heads/…` or `refs/tags/…`, a trailing `*` is a prefix). The full ref name the runner recorded on the applied revision's snapshot (`resolvedRef`) decides, not the requested name (`main`, `HEAD`); snapshots without `resolvedRef`, commit SHAs and `refs/pull/*` never qualify. Malformed values fail startup. List only apps that install apps for their user, such as Takos |
| `TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS` | Optional | the first-party native apps (Yurucommu `com.yurucommu`, Yurumeet `com.yurumeet`, Takos `jp.takos.mobile`) | Native phone apps whose declarations in a screen Interface's `document.clients` are trusted. A screen's app is `verified` only when its declared `bundleId` / `package` and its link templates match an entry; every other declaration is returned unverified with its real destination (`target`), and the dashboard and Takosumi Mobile must ask before opening it. JSON array (at most 32) of `[{"id":"notes-mobile","name":"Notes","ios":{"bundleId":"com.example.notes","appStoreId":"1234567890","testFlight":false,"schemes":["notes"],"universalLinkHosts":["open.notes.example"],"templates":["notes://connect?host_url={origin}","https://open.notes.example/connect#host_url={origin}"]},"android":{"package":"com.example.notes","schemes":["notes"],"appLinkHosts":["open.notes.example"],"templates":["notes://connect?host_url={origin}"]}}]`. `id` is a lowercase token, `name` (ASCII once accents are removed with NFKD, or Japanese without Latin letters) is shown for verified apps, `ios` and/or `android` are required; `schemes` and link hosts are owned by that entry (no other declaration may use them, and no two entries may share one); `templates` (1 to 16) are the exact `open` / link templates allowed, each using a listed scheme or host and containing `{origin}`, with only `{origin}` / `{url}` placeholders (at most four); `testFlight` allows a TestFlight `storeUrl`. Takosumi Mobile's own `com.takosumi`, Takosumi-owned domains, blocked schemes and the name Takosumi are refused. The value replaces the defaults entirely (`[]` trusts none). A malformed value (not a string, not JSON, an unknown field, or a value breaking these rules) verifies nothing and does not fall back to trusting the defaults, but the three defaults' names, schemes and link hosts stay reserved so unverified declarations cannot use them. Takosumi logs one structured error per isolate (process) naming only the entry index and field (such as `[0].name`), never the value, and Accounts, OIDC and the control API keep serving |
| `TAKOSUMI_APP_OWNERSHIP_MUTATIONS` | Optional | `enabled` | Operator kill switch for app member and ownership-transfer writes. `frozen` makes member add/remove/leave and transfer offer/accept/cancel return HTTP 409 `failed_precondition` with `details.reason: "app_ownership_mutations_frozen"`; reads keep working. Other values fail startup. Set `frozen` only while an ownership backfill runs (see `docs/operations/app-ownership-backfill.md`) |
| `TAKOSUMI_LEGACY_WORKSPACE_SUNSET` | Optional | unset | `Sunset` date announced on legacy Workspace route responses (ISO 8601 date or date-time, or an HTTP-date). Unset announces no `Sunset` (`Deprecation` is always sent). A value that is not a date fails startup. Set it once the TASK-0118 Phase 9 date for returning 410 is approved (see `docs/operations/legacy-workspace-telemetry.md`) |

A client registration looks like this:

```bash
export TAKOSUMI_ACCOUNTS_CLIENTS='[{"clientId":"takosumi-dashboard","redirectUris":["https://takosumi.example.com/sign-in/callback"],"tokenEndpointAuthMethod":"none"}]'
```

Upstream providers pass the descriptor and the secret separately. Writing the
secret value itself into the descriptor fails startup.

```bash
export TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS='[{"providerId":"company-sso","label":"Company SSO","issuer":"https://id.example.com","authorizationEndpoint":"https://id.example.com/oauth/authorize","tokenEndpoint":"https://id.example.com/oauth/token","userInfoEndpoint":"https://id.example.com/oauth/userinfo","clientId":"accounts-client","clientSecretEnv":"COMPANY_SSO_CLIENT_SECRET","redirectUri":"https://takosumi.example.com/sign-in/callback","scopes":["openid","profile","email"]}]'
export COMPANY_SSO_CLIENT_SECRET="<upstream client secret>"
```

`providerId` is a display and identification name; it does not select behavior.
Any number of providers can be listed.

## Retired Resource/Form HTTP surface

Takosumi OSS supports exactly one flow: the Git/OpenTofu/Terraform Stack flow.
The former Resource Shape, Form Host, Form Registry, FormActivation,
TargetPool, and SpacePolicy `/v1` routes and CLI domains are retired with no
flag to re-enable them. They always return `404`, never appear in
capabilities/OpenAPI, and cannot be revived through a bearer, the database, or
leftover rows.

Takosumi OSS also neither installs nor hosts Form Packages. A hosted service or operator that owns a Form
Host may record Host-specific trust policy and artifact binding in that Host's runbook, but that is
not a deploy path Takosumi OSS supports, and it creates no FormActivation or Offering. The portable
Takoform protocol is a contract for external Hosts, not a compatibility alias or a migration
surface. New users configure ordinary providers through Stack and ProviderConnection /
CredentialRecipe / ProviderBinding.

If an upgrade stops because retired tables still have rows, see
[Updating Takosumi itself](../self-host/upgrade.md#when-retired-tables-still-have-rows).

## Run and runner

| Variable                                  | Required | Default                                            | What it controls                                                                                                                                                                                             |
| ----------------------------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TAKOSUMI_ENABLED_RUNNER_PROFILES`        | Optional | `opentofu-default`                                 | Comma-separated IDs of execution profiles to enable. Empty means only the default one                                                                                                                        |
| `TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID`      | Optional | `opentofu-default`                                 | Profile used by requests that do not name one. Limited to profiles enabled above                                                                                                                             |
| `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR`      | Optional | `/tmp/takosumi-provider-cache` in the runner container | Path holding provider binaries reused across Runs. Credentials, generated roots, plans, and state never go here                                                                                              |
| `TAKOSUMI_SOURCE_BUILD_CACHE_DIR`         | Optional | none                                               | Dependency-package cache location used when running `sourceBuild`. Write an absolute path; the `bun` / `npm` / `xdg` subtrees are passed to Bun and npm                                                    |
| `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS`       | Optional | `0`                                                | How long, in seconds, an idle runner container stays up before it sleeps. Values above 0 are raised to at least 30 and capped at 900; `0` (the default) means 30 seconds. Whatever the value, a Run whose outcome is settled destroys its container explicitly, and a Run-scoped container is not reused by the next Run. Set `0` for new deployments |
| `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`      | Optional | `3` (`1` in the Cloudflare template's `wrangler.toml`) | zstd compression level for SourceSnapshot archives, `1` to `19`. Lower means larger archives and faster first ingestion                                                                                      |
| `TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH`    | Optional | `25`                                                | Upper bound of auto-sync Sources picked up per scheduled poll                                                                                                                                                |
| `TAKOSUMI_COMPATIBILITY_CHECK_TIMEOUT_MS` | Optional | `45000`                                            | Upper bound in milliseconds the request path waits for compatibility-check source expansion                                                                                                                  |
| `TAKOSUMI_UNINSTALL_GRACE_DAYS`           | Optional | `7`                                                | Grace period in whole days between scheduling an uninstall and the actual teardown, `0` to `365`. `0` removes the grace period: the next finalizer tick performs an unattended, system-approved destroy. An invalid value logs a warning and uses the default. A change applies to new requests; existing schedules keep their date |

Leaving `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR` empty makes the runner unpack
providers into per-Run work areas. Nothing is shared, and in exchange no
mix-up between Runs can happen.

Due uninstall requests are advanced by the hourly cron on Cloudflare and by an
in-process 15-minute cadence on PostgreSQL. Right before teardown the control
plane attempts one Capsule-scoped export and records its outcome on the
Capsule. A configuration without backup artifact storage records `skipped` and
proceeds with the teardown.

```bash
export TAKOSUMI_ENABLED_RUNNER_PROFILES="opentofu-default"
export TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR="/tmp/takosumi-provider-cache"
```

## Cloudflare-only variables

| Variable                               | Required                     | Default     | What it controls                                                                                                                             |
| -------------------------------------- | ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_CONTROL_D1_SCHEMA_MODE`      | Optional                     | `bootstrap` | `bootstrap` prepares the schema on request. `predeployed` stops that and only verifies read-only that the migration record is complete       |
| `TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE`     | Optional                     | `bootstrap` | The same choice for the Accounts D1. `bootstrap` creates tables with no version record on the first request. If you apply the schema with `takosumi accounts migrate-d1`, `predeployed` issues no DDL and the Worker only checks the version |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE`   | Optional                     | `observe`   | `observe` only reports gaps. `enforce` makes the internal inspection endpoint return `503` while evidence is missing                         |
| `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` | Required when `enforce`      | none        | Non-secret JSON answering the inspection above                                                                                               |
| `TAKOSUMI_RELEASE_ACTIVATOR_URL`       | Optional                     | none        | Webhook URL that takes over service publication after an apply                                                                               |
| `TAKOSUMI_RELEASE_ACTIVATOR_TOKEN`     | Required when the URL is set, **secret** | none        | Bearer passed to that webhook                                                                                                                |
| `TAKOSUMI_RELEASE_SOURCE_BUCKET`       | Optional                     | none        | SourceSnapshot bucket name passed to the webhook                                                                                             |

These go in `[vars]` in `wrangler.toml` or are pushed as secrets.

```bash
bunx wrangler secret put TAKOSUMI_RELEASE_ACTIVATOR_TOKEN \
  --config deploy/platform/wrangler.toml
```

## PostgreSQL-only variables

| Variable                                    | Required                           | Default                         | What it controls                                                         |
| ------------------------------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`         | Required when using Caddy          | `app.example.com`               | Public hostname users reach. Caddy obtains the ACME certificate for this name |
| `TAKOSUMI_ACCOUNTS_BIND_HOST`               | Optional                           | `0.0.0.0`                       | Address the container listens on                                         |
| `TAKOSUMI_ACCOUNTS_PORT`                    | Optional                           | `8787`                          | Listen port. `PORT` takes precedence when set                            |
| `TAKOSUMI_ACCOUNTS_STATIC_DIR`              | Optional                           | dashboard build inside the repo | Location of the dashboard distribution                                   |
| `TAKOSUMI_ACCOUNTS_PG_POOL_MAX`             | Optional                           | `20`                            | Connection pool cap                                                      |
| `TAKOSUMI_ACCOUNTS_PG_IDLE_TIMEOUT_MS`      | Optional                           | `30000`                         | Time before idle connections are dropped                                 |
| `TAKOSUMI_ACCOUNTS_PG_CONNECT_TIMEOUT_MS`   | Optional                           | `5000`                          | Time to wait for a connection to establish                               |
| `TAKOSUMI_ACCOUNTS_PG_STATEMENT_TIMEOUT_MS` | Optional                           | `30000`                         | Time to wait for a single statement                                      |
| `TAKOSUMI_ACCOUNTS_PG_SSL_MODE`             | Optional                           | `disable`                       | `disable` / `require` / `verify-ca` / `verify-full`                  |
| `TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT`        | Required for `verify-ca` / `verify-full` | none                            | PEM CA bundle                                                            |
| `TAKOSUMI_BACKUP_ARTIFACTS_DIR`             | Effectively required               | `/var/lib/takosumi/backups` in the reference Compose, otherwise none | Where pre-destroy exports and other backups are stored. If unset, export is recorded as `skipped` ([Backup and restore](../self-host/backup-restore.md)) |
| `POSTGRES_PASSWORD`                         | Required when using Docker Compose, **secret** | none                            | Password the bundled Docker Compose definition sets on PostgreSQL        |
| `TAKOSUMI_TCS_STORE_URL`                    | Optional                           | none                            | Public TCS store URL advertised as a string at `endpoints.extensions["takosumi.tcs-store.v1"]` in `/.well-known/takosumi`; the dashboard's `runtimeStoreUrl()` reads this extension. Use a public HTTP(S) URL without credentials, query, or fragment |

The bundled Docker Compose definition reads these from `deploy/node-postgres/.env`. If
`TAKOSUMI_TCS_STORE_URL` is unset, the dashboard uses build-time
`VITE_TAKOSUMI_TCS_STORE_URL`; with neither value set there is no default store.

```bash
cat >> deploy/node-postgres/.env <<'ENV'
TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME=takosumi.example.com
TAKOSUMI_ACCOUNTS_PG_SSL_MODE=require
ENV
```

## What the CLI reads

| Variable                         | Required                           | Default             | What it controls                                                                 |
| -------------------------------- | ---------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `TAKOSUMI_DEPLOY_CONTROL_URL`    | Required when `--url` is omitted   | none                | Takosumi origin the CLI talks to                                                 |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN`  | Required when `--token` is omitted, **secret** | none                | Bearer passed to that origin: normally a [token you created](./cli.md#creating-a-token). Commands that call the operator-only API, such as `takosumi connections`, need the server's operator secret |
| `TAKOSUMI_ACCOUNTS_URL`          | Required when `--accounts-url` is omitted | none                | accounts URL that `takosumi accounts tokens` talks to                            |
| `TAKOSUMI_ACCOUNTS_TOKEN`        | Used by `takosumi accounts tokens` when `--token` is omitted, **secret** | none | The Accounts session bearer (`sess_...`) that `takosumi accounts tokens` sends. Without it, the legacy `TAKOS_TOKEN` is read; with neither, the request is sent without a bearer and Accounts rejects it |
| `TAKOSUMI_ACCOUNTS_DATABASE_URL` | Required when `--database-url` is omitted | none                | Connection target for `takosumi accounts migrate`                                |
| `TAKOSUMI_LANG`                  | Optional                           | inferred from `LANG` etc. | Values starting with `ja` make the CLI help Japanese. `TAKOSUMI_LOCALE` is also read |

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat ~/.config/takosumi/token)"
takosumi connections list
```

## Related

- [Running it yourself](../concepts/self-host.md)
- [CLI](./cli.md)
- [Resource](../concepts/resources.md)
- [Product boundaries](../concepts/boundaries.md)
