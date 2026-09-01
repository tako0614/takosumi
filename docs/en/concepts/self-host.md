# Running it yourself

Takosumi can sit in your own environment and serve as your own endpoint. The software is
published under AGPL-3.0. There is one thing to stand up: the control plane, accounts, the
dashboard, and the OpenTofu runner all live on the same origin. The CLI, dashboard,
Takoform clients, and other API clients talk to that origin.

The repository's `deploy/` directory holds three templates that differ in where they put
things.

## Choosing a shape

| Shape | Where it runs | Where state lives | Template |
| --- | --- | --- | --- |
| Cloudflare | Cloudflare Workers | D1 / R2 / Durable Objects | `deploy/platform/wrangler.toml` |
| Bun and PostgreSQL | A VM or a container | PostgreSQL | `deploy/node-postgres/` |
| Local only | Your own Linux and Docker | Compose volumes | `deploy/local-substrate/` |

**Cloudflare** suits you when you would rather not keep servers. A Cloudflare account and
wrangler are enough, and OpenTofu execution is taken on by a runner in a Cloudflare
Container. Accounts, the control plane, the dashboard, and the runner all sit in one
Worker.

**Bun and PostgreSQL** suits you when it should live on your own infrastructure. You need
a host running Docker, PostgreSQL, and Caddy to terminate TLS. The bundled
`docker-compose.yml` brings up PostgreSQL, the migrations, the service itself, and Caddy
together.

**Local only** is for exercising the whole thing without exposing anything. It assumes
Linux and Docker. Pebble for ACME, CoreDNS, and Caddy come up on the same Docker network,
and `*.takosumi.test` resolves the same way it would in production.

## Putting it on Cloudflare

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

Runs are scheduled directly onto `RUN_OWNER` when they are created. This GA
composition has no Cloudflare Queue or dead-letter queue. `RUN_OWNER` owns
retries and terminal failure handling, and execution fails closed when its
binding is unavailable.

Create the resources first. The names match the template.

```bash
bunx wrangler d1 create takosumi-accounts
bunx wrangler d1 create takosumi-deploy
bunx wrangler r2 bucket create takos-artifacts
bunx wrangler r2 bucket create takosumi-source
bunx wrangler r2 bucket create takosumi-state
bunx wrangler r2 bucket create takosumi-backups
```

Copy `wrangler.toml` for your own use. What you rewrite is `database_id`, the `pattern`
under `routes`, and `TAKOSUMI_ACCOUNTS_ISSUER` under `[vars]`. The issuer is exactly the
origin that serves the dashboard. The template's `TAKOSUMI_ACCOUNTS_CLIENTS` holds an
example client whose redirect points at a domain you do not own. Replace it with your own
client, or delete it outright if you do not need one.

For a production deployment, add `TAKOSUMI_ENVIRONMENT = "production"` as well. When that
value is `production` or `staging`, the checks on encryption keys and persistent stores
become fail-closed. What each value means is collected in the
[configuration reference](/reference/configuration) (Japanese).

Build the dashboard. `ASSETS` serves this output.

```bash
bun install
bun run build:dashboard
```

Load the secrets. Keep them out of `wrangler.toml` and push them in with
`wrangler secret put`.

```bash
bunx wrangler secret put TAKOSUMI_ACCOUNT_SESSION_HASH_SALT \
  --config deploy/platform/wrangler.toml
```

Four more go in the same way. `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` and
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` cover OIDC signing.
`TAKOSUMI_SECRET_STORE_PASSPHRASE` is the sealing key for credentials and state, and
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` is the bearer for the operator-only API.

Apply the accounts D1 schema. This calls `bunx wrangler d1 execute` once per pending
migration, and the versions it applied stay in `takosumi_accounts_schema_migrations`.

```bash
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts --remote
```

The `takosumi` command runs from a checkout via `bun run cli --`; it is not published
to npm yet.

The command cannot be rolled back. Running it from two jobs at once makes one of them fail
on the primary key collision for a version, so call it from a single deploy job. To watch
what it does before your first deployment, add `--local` and it targets your local
miniflare instead.

The control plane D1 needs no migrations. While `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` is at
its default of `bootstrap`, the schema settles on the first request. To run against a
schema you prepared in advance, set it to `predeployed`.

Deploy last.

```bash
bunx wrangler deploy --config deploy/platform/wrangler.toml
```

## Putting it on Bun and PostgreSQL

The compose file in `deploy/node-postgres/` starts PostgreSQL, the migrations, the
OpenTofu runner, the service itself, and Caddy in that order. The service is a single
process carrying accounts, the control plane, and the dashboard on the same origin;
plan / apply execution runs in the bundled `opentofu-runner` container. Start from the
repository root.

```bash
cd deploy/node-postgres
cp .env.example .env
```

Edit `.env`. What you change here is `POSTGRES_PASSWORD`, `TAKOSUMI_ACCOUNTS_ISSUER`,
`TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`, the OIDC client registration, and the secrets
below. `.env.example` carries a template for each with a generation command — replace
every `replace-me` and you are done.

| Variable | Why it is needed |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` | The signing key for id_token |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | The subject derivation key that pairs with the signing key |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` | The salt that hashes session IDs at rest |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | The sealing key for credentials and state |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | The bearer for the operator-only API |
| `TAKOSUMI_RUNNER_SHARED_TOKEN` | The shared bearer between the service and the runner container |

The bundled `docker-compose.yml` passes all of these through to the `accounts` service;
no override file is needed. When the issuer is https and the signing key has not
arrived, the service refuses to start. Otherwise each process would sign id_tokens with
a different key, and verification would break across restarts and replicas.

Optional settings live in the same `.env`. Setting `TAKOSUMI_TCS_STORE_URL` fills the
dashboard's "Add a service" grid from that store; without it, adding from a Git URL
still works.

Bring it up.

```bash
docker compose up -d
```

The `migrations` container runs `takosumi accounts migrate` once, and then the service
starts. That covers the accounts tables only. The control plane tables are created
separately, against the same database.

Plan / apply execution lives in the `opentofu-runner` container. It listens only on the
compose-internal network and accepts no job without the `TAKOSUMI_RUNNER_SHARED_TOKEN`
bearer. Source archives and sealed state artifacts persist in the `takosumi-runtime`
volume (`/var/lib/takosumi`); deleting that volume loses applied state, so include it in
your backups.

Run the control plane migrations from a checkout of the repository; they are not in the
bundled image. The bundled compose exposes PostgreSQL only on the internal network, so
either publish 5432 first or run from a host that can reach it on that network.

```bash
cd ../..
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
```

Running `bun run db:migrate:dry-run` first prints the SQL without applying it. `--env=local`
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
databases of Chrome and Firefox. Pebble regenerates its root on every start, so after
redoing `up.sh`, run `ca-install.sh` again and restart the browser.

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
curl -s https://takosumi.example.com/v1/capabilities
```

With that much working, read real data once. Sign in to the dashboard, create a token by
following the [CLI](../reference/cli.md) steps, and list the Workspaces. A `200` rather
than a `401` means authentication and reading the records both work.

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

Finally, deploy something once. Put a Git URL into `/new` in the dashboard, create a plan,
read it, and apply. A successful Run that leaves a StateVersion and Outputs behind means
the runner and the state backend work too. `examples/opentofu-basic` needs no provider
credentials and is a good fit for this check.

## What to decide next

At this point the endpoint runs. What it makes available is then up to you. The Resource
types on offer, the targets, the runner's concurrency, the frequency of periodic
observation, and how secrets are handled are all settings. The list of variables and how to
choose them is in the [configuration reference](/reference/configuration) (Japanese).

What you end up taking on from the point of view of the people using that endpoint is set
out in [Product boundaries](./boundaries.md).
