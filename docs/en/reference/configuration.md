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
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | Required in real deployments, **secret**                    | none    | Bearer for the operator-only API, used by the CLI and operator clients. Does not affect the retired Resource/Form `/v1` surface                                                                                    |
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

The current Takosumi exposes no typed Host migration operations or settings
for Resource Shape, TargetPool, or other retired Host records. PostgreSQL
migration v110 and D1 migration v66 physically drop the target tables only
when all of them are empty. If rows remain, the forward migration stops there.
An affected operator should inventory and export those rows with the
immediately previous release or an external database tool, record explicitly
how they will be handled, empty the retired tables accordingly, and retry the
migration. The portable Takoform protocol is a contract for external Hosts,
not a compatibility alias or a migration surface. New users configure ordinary
providers through Stack and ProviderConnection / CredentialRecipe /
ProviderBinding.

## Run and runner

| Variable                                  | Required | Default                                            | What it controls                                                                                                                                                                                             |
| ----------------------------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TAKOSUMI_ENABLED_RUNNER_PROFILES`        | Optional | `opentofu-default`                                 | Comma-separated IDs of execution profiles to enable. Empty means only the default one                                                                                                                        |
| `TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID`      | Optional | `opentofu-default`                                 | Profile used by requests that do not name one. Limited to profiles enabled above                                                                                                                             |
| `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR`      | Optional | `/tmp/takosumi-provider-cache` in the runner container | Path holding provider binaries reused across Runs. Credentials, generated roots, plans, and state never go here                                                                                              |
| `TAKOSUMI_SOURCE_BUILD_CACHE_DIR`         | Optional | none                                               | Dependency-package cache location used when running `sourceBuild`. Write an absolute path; the `bun` / `npm` / `xdg` subtrees are passed to Bun and npm                                                    |
| `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS`       | Optional | `0`                                                | Legacy activity-expiry grace. Completed non-indeterminate Runs always destroy the container explicitly regardless of the value, and Run-scoped containers are never reused. Kept for input compatibility; set `0` for new deployments |
| `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`      | Optional | `3`                                                | zstd compression level for SourceSnapshot archives, `1` to `19`. Lower means larger archives and faster first ingestion                                                                                      |
| `TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH`    | Optional | `5`                                                | Upper bound of auto-sync Sources picked up per scheduled poll                                                                                                                                                |
| `TAKOSUMI_COMPATIBILITY_CHECK_TIMEOUT_MS` | Optional | `45000`                                            | Upper bound in milliseconds the request path waits for compatibility-check source expansion                                                                                                                  |

Leaving `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR` empty makes the runner unpack
providers into per-Run work areas. Nothing is shared, and in exchange no
mix-up between Runs can happen.

```bash
export TAKOSUMI_ENABLED_RUNNER_PROFILES="opentofu-default"
export TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR="/tmp/takosumi-provider-cache"
```

## Form Package settings (external Hosts only)

Takosumi OSS neither installs nor hosts Form Packages. A hosted service or
operator that owns a Form Host may record Host-specific trust policy and
artifact binding in that Host's runbook. Those settings are not a deploy path
Takosumi OSS supports, and they create no FormActivation or Offering.

## Cloudflare-only variables

| Variable                               | Required                     | Default     | What it controls                                                                                                                             |
| -------------------------------------- | ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_CONTROL_D1_SCHEMA_MODE`      | Optional                     | `bootstrap` | `bootstrap` prepares the schema on request. `predeployed` stops that and only verifies read-only that the migration record is complete       |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE`   | Optional                     | `observe`   | `observe` only reports gaps. `enforce` makes the internal inspection endpoint return `503` while evidence is missing                         |
| `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` | Required when `enforce`      | none        | Non-secret JSON answering the inspection above                                                                                               |
| `TAKOSUMI_RELEASE_ACTIVATOR_URL`       | Optional                     | none        | Webhook URL that takes over app publication after an apply                                                                                   |
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
| `POSTGRES_PASSWORD`                         | Required when using Docker Compose, **secret** | none                            | Password the bundled Docker Compose definition sets on PostgreSQL        |

The bundled Docker Compose definition reads these from `deploy/node-postgres/.env`.

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
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN`  | Required when `--token` is omitted, **secret** | none                | Bearer passed to that origin                                                     |
| `TAKOSUMI_ACCOUNTS_URL`          | Required when `--accounts-url` is omitted | none                | accounts URL that `takosumi accounts tokens` talks to                            |
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
