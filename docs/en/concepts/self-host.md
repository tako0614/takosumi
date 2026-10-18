# Running it yourself

Takosumi can sit in your own environment and serve as your own endpoint. The software is
published under AGPL-3.0. The control plane, accounts, and dashboard share the origin users
connect to. OpenTofu runner and source/artifact/state persistence vary by composition. The
CLI, dashboard, Takoform clients, and other API clients talk to that origin.

The repository's `deploy/` directory holds three templates that differ in where they put
things.

## Choosing a shape

| Shape and template | Plan and apply | Where it runs | Where state lives |
| --- | --- | --- | --- |
| **Cloudflare**<br>`deploy/platform/` | Plan, yes. Apply and destroy need digests from the release tool ([below](#about-apply-and-destroy)) | Cloudflare Workers | D1 / R2 / Durable Objects |
| **Bun and PostgreSQL**<br>`deploy/node-postgres/` | Only once you compose in a runner | A VM or a container | PostgreSQL |
| **Local only**<br>`deploy/local-substrate/` | Yes, with `--profile postgres` (a bundled runner container) | Your own Linux and Docker | Compose volumes |

**Cloudflare** suits you when you would rather not keep servers. You need a Cloudflare
account on the Workers Paid plan and a domain whose DNS Cloudflare manages. OpenTofu
execution is taken on by a runner in a Cloudflare Container. Accounts, the control
plane, the dashboard, and the runner all sit in one Worker.

**Bun and PostgreSQL** suits you when it should live on your own infrastructure. You need
a host running Docker, PostgreSQL, and Caddy to terminate TLS. The bundled
`docker-compose.yml` brings up PostgreSQL, the migrations, the service itself, and Caddy
together. It does not include an OpenTofu runner, so plan and apply need a runner composed
in separately.

**Local only** is for exercising the whole thing without exposing anything. You need
Linux, Docker, Bun, and `sudo` to set up certificates and DNS. Pebble for ACME, CoreDNS,
and Caddy come up on the same Docker network, and `*.takosumi.test` resolves the same way
it would in production.

## Costs

The Takosumi software has no fee (AGPL-3.0). What you pay for is where you run Takosumi and the
resources that the apps you add create.

- **Cloudflare** — Cloudflare bills the Workers Paid plan and your usage of Workers, Containers,
  D1, R2, Durable Objects, and logs (observability). Loading the dashboard also counts as Worker
  requests. A domain costs extra. See Cloudflare's
  [Workers pricing](https://www.cloudflare.com/plans/developer-platform/) and
  [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) for
  amounts.

  The runner container (2 vCPU, 6 GiB, and 10 GB disk in the template, at most 10 instances)
  starts for a review, a deploy, a deletion, a repository fetch, a pre-add check, and a restore,
  backup, or stable-tag lookup that a user requests. Repositories that sync automatically also
  start it at the hourly check. Drift checks and automatic reviews of services with updates start
  it only when you enable them. Each time, it stops when that work ends or after about 30 seconds
  without activity.
- **Bun and PostgreSQL** — the server that runs Docker, and PostgreSQL. Plan and apply also need a
  separately composed runner, which costs whatever it runs on.
- **Entirely local** — Takosumi itself runs only on your own machine.
- **Resources of the apps you add** — the Workers, buckets, databases, and so on that an app
  creates are billed to the connected account by its provider, such as Cloudflare.

## Putting it on Cloudflare

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

### Make your own config

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

### Install the Accounts D1 schema

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
[Updating Takosumi itself](../self-host/upgrade.md).

The control plane D1 needs no migrations. While `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` is at
its default of `bootstrap`, the schema settles on the first request. To run against a
schema you prepared in advance, set it to `predeployed`.

### Deploy with the secrets

wrangler prefers a `CLOUDFLARE_API_TOKEN` in the environment over `wrangler login`. Unset it
first so the deploy does not run with a token that only has D1 permission.

`wrangler secret put` cannot set secrets before the Worker exists. Put the secrets in a
private JSON file and send them with the first deploy. They are
`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`, `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`,
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`, `TAKOSUMI_SECRET_STORE_PASSPHRASE` (the
sealing key for credentials and state), `TAKOSUMI_DEPLOY_CONTROL_TOKEN` (the bearer for the
operator-only API), the upstream identity provider's client secret, and
`TAKOSUMI_ACCOUNTS_SUBJECT_SECRET`. Generate the values as in
[Putting it on Bun and PostgreSQL](#putting-it-on-bun-and-postgresql). Every value must be a
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

### About apply and destroy

A Worker set up this way can create reviews (plan), but apply and destroy stop. They need
three digests that identify the running artifacts (`TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST`,
`TAKOSUMI_RUNNER_ARTIFACT_DIGEST`, and `TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST`). Today only the
Takosumi release tool produces them, and there is no self-host procedure for them yet. A
Worker without them fails apply and destroy Runs with `execution_evidence_authority_unavailable`
without touching the provider.

## Putting it on Bun and PostgreSQL

The compose file in `deploy/node-postgres/` starts PostgreSQL, the migrations, the service
itself, and Caddy in that order. The service is a single process carrying accounts, the
control plane, and the dashboard on the same origin. Start from the repository root.

```bash
cd deploy/node-postgres
[ -e .env ] || cp .env.example .env
```

Edit `.env`. Compose uses this file for interpolation and passes only the service
settings declared in `docker-compose.yml` to `accounts`. Fill in at least the following. The command
that generates each value is written next to it in `.env.example`.

| Variable | Why it is needed |
| --- | --- |
| `POSTGRES_PASSWORD` | The PostgreSQL password |
| `TAKOSUMI_ACCOUNTS_ISSUER` / `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` | The public origin, and the hostname Caddy obtains a certificate for |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` | The signing key for id_token |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | The subject derivation key that pairs with the signing key |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` | The salt that hashes session IDs at rest |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | The sealing key for credentials and state |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | The bearer for the operator-only API |

When the issuer is https and the signing key has not arrived, the service refuses to
start. Otherwise each process would sign id_tokens with a different key, and verification
would break across restarts and replicas. Without the sealing key it also refuses to start
rather than store secrets in plaintext.

`.env` also decides how people sign in. The first account is created by signing in through
an upstream identity provider (`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`, plus the secret
named by its `clientSecretEnv`). Passkeys (`TAKOSUMI_ACCOUNTS_PASSKEY_*`) are added to an
account after it has signed in. `.env.example` has an example of each.
Explicitly map each arbitrary `clientSecretEnv` name in
`docker-compose.override.yml` under `accounts.environment`; setting it in `.env`
alone does not pass it to the container. See the override example in the
`deploy/node-postgres/README.md`.

Generate the five random values above with independent `openssl rand -hex 32` invocations.
Replace the placeholder ES256 key with a real P-256 private JWK using the Bun command in
`.env.example`. For a local HTTP smoke test, set issuer and passkey origin to
`http://localhost:26401`, client redirect URI to `http://localhost:26401/oauth/callback`,
and passkey RP ID to `localhost`. Production uses the
public HTTPS origin and hostname instead.

`.env` holds secrets, so do not commit it. This repository ignores
`deploy/node-postgres/.env` in `.gitignore`.

### Local loopback check

Run this in the same shell after setting up `.env`; the earlier commands left you in
`deploy/node-postgres`.
Keep the temporary override outside the checkout and use a unique Compose project. Accounts
starts its PostgreSQL and migration dependencies; Caddy is not started, so the local check
does not request ACME or expose ports 80/443.

```bash
set -euo pipefail
local_project="takosumi-local-test-$(date +%s)-$$"
local_dir="$(mktemp -d)"
cat > "$local_dir/compose.local-test.yml" <<'YAML'
services:
  accounts:
    environment:
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: ""
    ports:
      - "127.0.0.1:26401:8787"
YAML
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose up --build -d --wait accounts
local_compose ps
curl -fsS http://localhost:26401/healthz
```

`--wait` requires Docker Compose v2. This temporary composition does not load the checkout's
general `docker-compose.override.yml`; its only host port is bound to loopback.

Wait for `migrations` to exit successfully and `accounts` to become healthy. Open
`http://localhost:26401/` to check the dashboard. By default this health/dashboard smoke test
disables upstream providers and does not create an account. To check sign-in, replace the
empty `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` value in the temporary override before startup
and add that descriptor's `clientSecretEnv` mapping there. Do not load
`docker-compose.override.yml` wholesale, as it may publish additional host ports. Align the
provider and client callbacks to `localhost:26401`. To stop this test and remove its temporary
override, run the following in the same shell. The dedicated PostgreSQL volume remains.

```bash
local_compose down
rm -rf "$local_dir"
```

### Public HTTPS deployment

For production, configure a real HTTPS issuer and public hostname, then start the default
composition. This starts Caddy on ports 80/443 and requires the hostname to resolve to this
host and be reachable for ACME.

```bash
docker compose up --build -d
curl -fsS https://app.example.com/healthz # replace with the configured public hostname
```

The first run spends a few minutes building the image. The `migrations` container applies
both schemas, the control plane's and the accounts', to the same database, and the service
and Caddy start once it succeeds.

To apply the migrations from outside compose, run them from the repository root. The
bundled compose exposes PostgreSQL only on the internal network, so either publish 5432
first or run from a host that can reach it on that network.

```bash
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
takosumi accounts migrate --database-url "$DATABASE_URL"
```

Running `bun run db:migrate:dry-run` first prints the SQL without applying it. It prints the whole catalog, not only what this database has not applied yet. `--env=local`
runs in memory without connecting, so it touches no real database. The only `--env` values
that reach a real database are `production` and `staging`.
Both are forward-only and expose no down/rollback command. Disposable fixture
reset is limited to an injected local/development/test client and cannot read
the database URL or production credentials described here.

To run it by hand instead of through compose, pass the same environment variables and start
`bun deploy/node-postgres/src/server.ts`. What it listens on is decided by
`TAKOSUMI_ACCOUNTS_BIND_HOST` (default `0.0.0.0`) and `PORT` (default `8787`).

`takosumi accounts serve` is for checking things locally. It creates a throwaway signing
key per process, so run a public accounts plane from the Cloudflare template or the Bun and
PostgreSQL one.

This template has no OpenTofu runner. Accounts, the control plane, and the dashboard work,
but Git sync, plan, and apply fail with `runner_capability_missing`. To plan and apply, use a
composition that includes a runner: the Cloudflare one, or a composition you assemble
yourself that attaches a runner container the way `deploy/local-substrate/` does.

## Running it entirely locally

This runs the whole thing on your own Linux machine with nothing exposed.

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
bash scripts/smoke.sh
```

`ca-install.sh` installs Pebble's root CA into the host trust store and into the NSS
databases of Chrome and Firefox. Pebble regenerates its root every time its container
starts. After `down.sh` and a new `up.sh`, or when certificate errors appear after the
host restarts, run `ca-install.sh` again and restart the browser. The
[Quickstart](../getting-started/quickstart.md) explains what both scripts change and how
to undo them.

## Confirming it works

First, see that the process answers.

```bash
curl -s https://takosumi.example.com/healthz
```

Next, see that its dependencies are in place. On the Cloudflare shape, `/readyz` inspects
the bindings and returns `503` naming anything missing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://takosumi.example.com/readyz
```

OIDC discovery shows whether the foundation for signing in is standing. When `issuer`
comes back with the same value as `TAKOSUMI_ACCOUNTS_ISSUER`, the configuration is right.

```bash
curl -s https://takosumi.example.com/.well-known/openid-configuration
```

Product discovery tells you what this endpoint has enabled.

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
curl -s https://takosumi.example.com/api/v1/capabilities
```

With that much working, read real data once. Sign in to the dashboard, create an API key
with **Read** (untick **Restrict this key to the current Workspace** if it is
shown), as in [Creating a token](../reference/cli.md#creating-a-token), and list the
Workspaces. Export the key as `TAKOSUMI_READ_TOKEN`. Scopes do not include one another, so a `write`-only token gets `403` here. Use
the token you created, not the operator-only `TAKOSUMI_DEPLOY_CONTROL_TOKEN`. A `200` means
authentication and reading the records both work.

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_READ_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

Finally, deploy something once on a composition that includes a runner. Put a Git URL into `/new` in the dashboard, create a plan,
read it, and apply. A successful Run that leaves a StateVersion and Outputs behind means
the runner and the state backend work too. On Cloudflare without the three digests, check up
to creating the plan, as described in [About apply and destroy](#about-apply-and-destroy). `examples/opentofu-basic` needs no provider
credentials and is a good fit for this check.

## What to decide next

At this point the endpoint runs. What it makes available is then up to you. The runner
profiles you enable, the upper limit on Sources picked up per scheduled poll, the deletion
grace period, and how secrets are stored are all settings. The list of variables and how to
choose them is in the [configuration reference](/en/reference/configuration).

What you end up taking on from the point of view of the people using that endpoint is set
out in [Product boundaries](./boundaries.md).

[operations guide](../self-host/index.md)
