# Putting it on Bun and PostgreSQL

Choosing a shape and its costs are covered in [Running it yourself](../concepts/self-host.md). This page
sets up the Bun and PostgreSQL template `deploy/node-postgres/`.

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
`deploy/node-postgres/README.md`. The descriptor's `redirectUri` is
`https://<your origin>/sign-in/callback`; register exactly this URI with the identity provider.

Generate the five random values above with independent `openssl rand -hex 32` invocations.
Replace the placeholder ES256 key with a real P-256 private JWK using the Bun command in
`.env.example`. For a local HTTP smoke test, set issuer and passkey origin to
`http://localhost:26401`, client redirect URI to `http://localhost:26401/oauth/callback`,
and passkey RP ID to `localhost`. Production uses the
public HTTPS origin and hostname instead.

`.env` holds secrets, so do not commit it. This repository ignores
`deploy/node-postgres/.env` in `.gitignore`.

## Local loopback check

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

## Public HTTPS deployment

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

## Making `/readyz` pass

On this shape, `/readyz` returns `503` with `internalApiSecret` in its reason unless
`TAKOSUMI_INTERNAL_API_SECRET` is set. The bundled Compose does not pass it, and nothing but this
check uses it today. To make `/readyz` pass too, put a
value from `openssl rand -hex 32` in `.env` **first**, then pass it in
`docker-compose.override.yml`. Without the value in `.env`, this override makes every
`docker compose` command fail, including `down` and `logs`:

```yaml
services:
  accounts:
    environment:
      TAKOSUMI_INTERNAL_API_SECRET: ${TAKOSUMI_INTERNAL_API_SECRET:?set TAKOSUMI_INTERNAL_API_SECRET in .env}
```
