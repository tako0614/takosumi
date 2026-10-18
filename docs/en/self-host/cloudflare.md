# Putting it on Cloudflare

Choosing a shape and its costs are covered in [Running it yourself](../concepts/self-host.md). This page
puts the Cloudflare template `deploy/platform/` on your own account.

What you need:

- A Cloudflare account on the Workers Paid plan. The runner uses Cloudflare Containers,
  which the Free plan does not offer.
- R2 enabled on the account. Even within the free tier, you cannot create buckets until
  you complete the one-time R2 purchase step in the Cloudflare dashboard.
- A domain whose DNS Cloudflare manages. The `routes` hostname is registered as a custom
  domain, and its origin becomes the Accounts issuer.
- Docker running on the machine where you run `wrangler deploy`. The deploy builds the
  runner image from `runner/Dockerfile`.
- Bun and a checkout of this repository, to build the dashboard and to run the `takosumi`
  CLI that applies the Accounts D1 schema.

Every binding you need is written out in `deploy/platform/wrangler.toml`.

| Binding | Role |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_DB` (D1) | Stores sessions, OIDC, and PATs |
| `TAKOSUMI_CONTROL_DB` (D1) | The record of Runs, StateVersions, and Outputs |
| `R2_ARTIFACTS` | Holds plan and state artifacts |
| `R2_SOURCE` | Holds the tar.zst of each SourceSnapshot |
| `R2_STATE` | The OpenTofu state backend |
| `R2_BACKUPS` | Holds backup and export bundles |
| `COORDINATION` / `RUN_OWNER` / `RUNNER` (Durable Object) | Mutual exclusion, Run ownership, and the runner container |
| `ASSETS` | Serves the dashboard build |

Runs are scheduled directly onto `RUN_OWNER` when they are created. This composition
uses neither Cloudflare Queue nor a dead-letter queue for failed work.
`RUN_OWNER` handles retries and final failure, and if its binding is missing, Runs are
not sent to execution (fail closed).

Install the wrangler version this repository pins, and sign in. The `bun run wrangler`
commands below use that version.

```bash
bun install
bun run wrangler -- login
```

Create the resources. The names match the template.

```bash
bun run wrangler -- d1 create takosumi-accounts
bun run wrangler -- d1 create takosumi-deploy
bun run wrangler -- r2 bucket create takos-artifacts
bun run wrangler -- r2 bucket create takosumi-source
bun run wrangler -- r2 bucket create takosumi-state
bun run wrangler -- r2 bucket create takosumi-backups
```

## Make your own config

Do not edit the template `deploy/platform/wrangler.toml`; copy it outside the checkout.
`takosumi accounts migrate-d1`, used below, runs only on a checkout with no changes.

```bash
install -d -m 700 "$HOME/.takosumi-private"
cp deploy/platform/wrangler.toml "$HOME/.takosumi-private/wrangler.toml"
```

In the copy, rewrite the following. `<checkout>` is the absolute path of this repository. The
template's relative paths resolve from the config file's location, so use absolute paths in
the copy.

| Item | Value |
| --- | --- |
| Both `database_id` entries | The IDs that `d1 create` printed |
| `pattern` under `[[routes]]` | The hostname you publish |
| `TAKOSUMI_ACCOUNTS_ISSUER` under `[vars]` | The origin that serves the dashboard (starting with `https://`) |
| `main` (add at the top) | `"<checkout>/deploy/platform/entry-worker.ts"` |
| `directory` under `[assets]` (add) | `"<checkout>/dashboard/dist"` |
| `image` and `image_build_context` under `[[containers]]` | `"<checkout>/runner/Dockerfile"` and `"<checkout>"` |
| `TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE` under `[vars]` (add) | `"predeployed"`. The CLI below installs the Accounts D1 schema; the Worker does not create it |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` under `[vars]` (add) | The upstream identity provider descriptors used for sign-in, as a JSON **string**. Write it as a TOML literal string such as `'[{"providerId": ...}]'` |

This config holds values from your environment, so keep it somewhere private. The template's
`[vars]` already sets `TAKOSUMI_ENVIRONMENT = "production"`. When the value is `production`
or `staging`, the service refuses to start, rather than warning, if the encryption keys and
durable stores fail their checks (fail closed). The
[configuration reference](../reference/configuration.md) explains each value.

The first account is created by signing in through the upstream identity provider. A passkey
is something you add to an account after signing in. The
[configuration reference](../reference/configuration.md) shows how to write
`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`. The provider's client secret and
`TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` go with the secrets below. The descriptor's `redirectUri` is
`https://<your origin>/sign-in/callback`; register exactly this URI with the identity provider. On Cloudflare, a broken descriptor leaves no way to
sign in and logs `auth_providers_upstream_oauth_disabled`. If you write the value as a TOML
array, the Worker does not receive it as a string, and sign-in disappears without any log.

Build the dashboard. `ASSETS` serves this output. The dashboard is not part of the root
workspace, so `build:dashboard` installs its dependencies from the dashboard's own lockfile
before building.

```bash
bun run build:dashboard
```

## Install the Accounts D1 schema

Apply the Accounts D1 schema with the `takosumi` CLI from the checkout, before the deploy;
[CLI](../reference/cli.md) shows how to set it up. Until the Accounts D1 is at a version it
accepts, the Worker does not handle requests and logs `accounts_d1_schema_incompatible`.
Because the table above sets `predeployed`, the Worker issues no DDL to the Accounts D1 and
only checks the version.

Set these environment variables:

| Variable | Contents |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with D1 Edit permission. The CLI never prints it |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_DATABASE_ID` | The database ID of `takosumi-accounts` |
| `SOURCE_COMMIT` | The commit of a clean checkout (`git rev-parse HEAD`). If it does not match, the CLI stops before touching anything outside |

Each step prints its result as JSON. Set `BACKUP_EVIDENCE_DIGEST` to the
`backupEvidenceDigest` that backup-status prints. Set `SOURCE_DIGEST`, `CATALOG_DIGEST`,
`TARGET_DIGEST`, and `CONFIGURATION_DIGEST` to the `sourceDigest`, `catalogDigest`,
`targetDigest`, and `configurationDigest` that plan prints. Give `--out` a new file name
each time; the CLI stops if the file already exists.

```bash
# 1. Record the state before applying. Writes the Time Travel bookmark to a private
#    file and prints backupEvidenceDigest.
takosumi accounts migrate-d1 backup-status \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --out "$HOME/.takosumi-private/accounts-d1-backup-$(date +%Y%m%d%H%M%S).json"
# 2. See what will be applied. Makes no remote call.
takosumi accounts migrate-d1 plan \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --backup-evidence-digest "$BACKUP_EVIDENCE_DIGEST"
# 3. Check the four digests plan printed, then apply
#    (... stands for every option you gave plan).
takosumi accounts migrate-d1 apply ... \
  --confirm-source-digest "$SOURCE_DIGEST" \
  --confirm-catalog-digest "$CATALOG_DIGEST" \
  --confirm-target-digest "$TARGET_DIGEST" \
  --confirm-configuration-digest "$CONFIGURATION_DIGEST"
# 4. Check the result, read-only.
takosumi accounts migrate-d1 verify ...
```

On a new D1 database, apply runs every version from the first to the latest in order. It
sends one atomic batch per migration and never retries on its own after a failure; check
the state with the read-only `status` before deciding what to do next. The CLI never
restores a database. Keep the bookmark file private and outside the checkout, because it is
what a restore would start from. Once applied, you cannot go back to an older Worker that
does not accept that version. To upgrade the Accounts D1 of a running installation, see
[Updating Takosumi itself](./upgrade.md).

The control plane D1 needs no migrations. While `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` is at
its default of `bootstrap`, the schema settles on the first request. To run against a
schema you prepared in advance, set it to `predeployed`.

## Deploy with the secrets

wrangler prefers a `CLOUDFLARE_API_TOKEN` in the environment over `wrangler login`. Unset it
first so the deploy does not run with a token that only has D1 permission.

`wrangler secret put` cannot set secrets before the Worker exists. Put the secrets in a
private JSON file and send them with the first deploy. They are
`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`, `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`,
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`, `TAKOSUMI_SECRET_STORE_PASSPHRASE` (the
sealing key for credentials and state), `TAKOSUMI_DEPLOY_CONTROL_TOKEN` (the bearer for the
operator-only API), the upstream identity provider's client secret, and
`TAKOSUMI_ACCOUNTS_SUBJECT_SECRET`. Generate the values as in
[Putting it on Bun and PostgreSQL](./bun-postgres.md). Every value must be a
string; put the ES256 JWK in as its generated JSON, escaped into a string. Name the client
secret exactly as the descriptor's `clientSecretEnv`.

```json
{
  "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK": "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"...\",\"x\":\"...\",\"y\":\"...\"}",
  "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT": "...",
  "COMPANY_SSO_CLIENT_SECRET": "..."
}
```

```bash
unset CLOUDFLARE_API_TOKEN
# Write $HOME/.takosumi-private/secrets.json in the shape above
chmod 600 "$HOME/.takosumi-private/secrets.json"
bun run wrangler -- deploy \
  --config "$HOME/.takosumi-private/wrangler.toml" \
  --secrets-file "$HOME/.takosumi-private/secrets.json"
```

Pass the same file with `--secrets-file` on every later deploy too. Treat secrets.json like any
other secret and keep it somewhere private.

## About apply and destroy

A Worker set up this way can create reviews (plan), but apply and destroy stop. They need
three digests that identify the running artifacts (`TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST`,
`TAKOSUMI_RUNNER_ARTIFACT_DIGEST`, and `TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST`). Today only the
Takosumi release tool produces them, and there is no self-host procedure for them yet. A
Worker without them fails apply and destroy Runs with `execution_evidence_authority_unavailable`
without touching the provider.
