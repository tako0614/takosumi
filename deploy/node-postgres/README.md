# Takosumi Account Plane — Bun + Postgres substrate

Substrate-neutral counterpart to `deploy/accounts-cloudflare/`. The account-plane handler runs on Bun against a Postgres database, fronted by Caddy for TLS. Use this when the composed Takosumi origin is hosted on a VM, container host, or Kubernetes pod instead of Cloudflare.

The handler is the same `createAccountsHandler` mounted in the platform worker. Only the substrate plumbing differs:

| layer   | Cloudflare reference    | Bun + Postgres reference             |
| ------- | ----------------------- | ------------------------------------ |
| compute | Cloudflare Workers (V8) | Bun on a VM / container              |
| storage | D1 (`D1AccountsStore`)  | Postgres (`PostgresAccountsStore`)   |
| TLS     | Cloudflare edge         | Caddy automatic HTTPS                |
| secrets | operator secret binding | `.env` file or operator secret store |

The account plane is the backing layer for session cookies, upstream sign-in, the bare-origin OIDC issuer, dashboard
account records, session/OIDC/PAT state, and the dashboard facade. It is mounted on the same composed Takosumi origin as
the dashboard and control plane; it is not a second control plane and does not require a dedicated accounts subdomain.
Workspace / Project / Capsule / Run / StateVersion / Output resources are created and read through the control-plane
surface. Accounts does not maintain a second Capsule/runtime or Run/Output ledger;
runtime contracts are canonical Interface / InterfaceBinding records.

## Quick start

The reference Compose file includes Caddy for a public HTTPS deployment. For a local
smoke check, start only PostgreSQL, migrations, and accounts in a dedicated Compose project,
and bind the service to loopback. This avoids exposing a development listener and does not
start Caddy or request an ACME certificate. Run from the repository root:

```bash
cd deploy/node-postgres
test ! -e .env && cp .env.example .env
```

Replace the example secrets in `.env`. Generate independent values with
`openssl rand -hex 32` for `POSTGRES_PASSWORD`,
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`,
`TAKOSUMI_SECRET_STORE_PASSPHRASE`, `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`, and
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`. Generate a real P-256 private JWK with the Bun command
shown in `.env.example`; replace its placeholder JWK. For local HTTP testing set issuer and
passkey origin to `http://localhost:26401`, the client redirect URI to
`http://localhost:26401/oauth/callback`, and the passkey RP ID to `localhost`. An HTTPS
issuer requires a stable signing JWK.

Create a temporary override outside the checkout to publish only the loopback port. Use a
unique project name for this disposable test, then start Accounts (Compose starts its
PostgreSQL and migration dependencies). Caddy is not started.

```bash
set -euo pipefail
local_dir="$(mktemp -d)"
local_project="takosumi-local-test-$(date +%s)-$$"
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

`--wait` requires Docker Compose v2. The host publication stays loopback-only. Do not load
the checkout's general-purpose `docker-compose.override.yml`, since it may publish extra
ports; add only the reviewed upstream secret mapping to this temporary override if needed.

Wait for `migrations` to exit successfully and `accounts` to become healthy. Open
`http://localhost:26401/` to check the dashboard. By default this health/dashboard smoke test
has no upstream provider and does not create an account. To enable sign-in, replace the empty
provider value in the temporary override with a provider descriptor before startup and add its
`clientSecretEnv` mapping there as shown below. Do not add the existing
`docker-compose.override.yml` wholesale: it may publish other host ports. Copy only the
required secret environment mapping into the temporary override and align the provider/client
callback with `localhost:26401`. To stop the local test without deleting
the named database volume, run:

```bash
local_compose down
rm -rf "$local_dir"
```

The dedicated PostgreSQL volume persists after `down`; that command does not remove it.

For public production service, configure a real HTTPS issuer and public hostname in `.env`,
review the secret and upstream-provider settings below, then start the default composition
with `docker compose up --build -d`. This starts Caddy on ports 80/443; its hostname must
resolve to the host and be reachable for ACME. Do not use that public Caddy composition as
the local smoke-test procedure.

Compose reads `.env` for interpolation. `docker-compose.yml` passes only the
declared service settings to `accounts`; the separate `POSTGRES_PASSWORD`
variable and Caddy's hostname are not passed to that container. The database
connection URL still contains the password the service needs. The
`migrations` container applies the control-plane schema
(`core/scripts/db-migrate.ts`) and then the accounts schema before the service
starts. Caddy obtains the certificate for `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`
over ACME, so that name must resolve to this host; it serves no other site
label.

To select a TCS store, set `TAKOSUMI_TCS_STORE_URL` in `.env`. Compose passes it to the
service, which advertises it at `/.well-known/takosumi` under
`endpoints.extensions["takosumi.tcs-store.v1"]` as a URL string. The dashboard's
`runtimeStoreUrl()` reads that extension. Use a public HTTP(S) URL without credentials,
query, or fragment. When unset, the dashboard uses
build-time `VITE_TAKOSUMI_TCS_STORE_URL`; if neither is set, there is no default store.
This setting does not add a runner or artifact store to the stock composition.

On an existing installation, the next `docker compose up -d` runs pending
control-plane migrations from the image before Accounts migrations and before
Compose starts `accounts`. Already-applied migrations are skipped. Back up the database
and review pending migrations before upgrading: both catalogs are forward-only,
so reverting the image does not undo schema/data changes. Restore a verified
backup or use forward repair if recovery is needed. After a source update, use
`docker compose up --build -d` to rebuild the image first.
Dependency ordering does not stop an already-running `accounts` container. If
pending migrations require service quiescence, stop it before upgrading with
`docker compose stop accounts`.

Production `.env` values (`.env.example` documents secret generation):

```
POSTGRES_PASSWORD=replace-me-with-a-strong-passphrase
TAKOSUMI_ACCOUNTS_ISSUER=https://app.example.com
TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME=app.example.com
TAKOSUMI_ACCOUNTS_BIND_HOST=0.0.0.0
TAKOSUMI_ACCOUNTS_CLIENT_ID=takos-app
TAKOSUMI_ACCOUNTS_REDIRECT_URIS=https://app.example.com/oauth/callback
# Stable OIDC signing key + pairwise secrets. REQUIRED for an https issuer:
# without these the service fails closed at startup rather than falling back to
# a per-process ephemeral signing key (which breaks id_token verification on
# restart / under horizontal scale). Generate a P-256 ES256 JWK with a private
# "d" coordinate; the pairwise secret is an independent 64-char random string.
TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK={"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}
TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET=replace-me-with-a-64-char-random-string
# Server secrets. Without the passphrase the service refuses to start; without
# the salt it hashes sessions with a public dev-only salt.
TAKOSUMI_SECRET_STORE_PASSPHRASE=
TAKOSUMI_ACCOUNT_SESSION_HASH_SALT=
TAKOSUMI_DEPLOY_CONTROL_TOKEN=
```

The first account signs in through an upstream identity provider
(`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`); passkeys are added to an account after
it has signed in.

For each upstream descriptor's arbitrary `clientSecretEnv` name, explicitly
forward that one secret in `docker-compose.override.yml`. For the example in
`.env.example`, keep the value in `.env` or your operator environment and add:

```yaml
services:
  accounts:
    environment:
      COMPANY_SSO_CLIENT_SECRET: ${COMPANY_SSO_CLIENT_SECRET:?set the upstream client secret}
```

Compose loads this override automatically with `docker compose up -d`. Add one
mapping per configured secret name; avoid passing a whole secret file through
`env_file`. A missing upstream binding prevents the service from starting.

This reference composition has no OpenTofu runner. Git sync, plan, and apply
fail with `runner_capability_missing` until an operator composition supplies
one (see `deploy/local-substrate/`).

For a Takos native shell, register a separate host-specific public client in
`TAKOSUMI_ACCOUNTS_CLIENTS`. Its `redirectUris` entry must be exactly
`takos://oauth/callback`, `tokenEndpointAuthMethod` must be `none`, and
`allowedScopes` must list only the Takos mobile API scopes the shell uses. Set
the same `clientId` as `OIDC_MOBILE_CLIENT_ID` on that Takos Worker. Do not put a
client secret in the app or reuse the browser client's id.

For the standalone Takosumi app, register another public client with the exact
`takosumi://oauth/callback` redirect and the `openid profile offline_access
capsules:read capsules:write` scopes, then select it with the non-secret
`TAKOSUMI_MOBILE_OIDC_CLIENT_ID`. The composed server validates and publishes
that id through `/.well-known/takosumi`.

## Files

- `src/server.ts` — Bun entry point. Uses `Bun.serve` and wires the shared accounts handler against `PostgresAccountsStore`.
- `src/handler.ts` — env parsing, mirrors the Cloudflare worker's config shape.
- `Dockerfile` — multi-stage build that installs the Bun workspace and ships a minimal Bun runtime image.
- `docker-compose.yml` — Postgres + accounts + Caddy stack.
- `Caddyfile.example` — reverse proxy + automatic HTTPS template.

## Listener vs. public hostname

The Caddy site label and the Bun listener bind address are intentionally separate env vars:

- `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` — the hostname of the composed Takosumi origin your users dial (e.g. `app.example.com`). Caddy uses this as the site label in `Caddyfile.example` and obtains an ACME certificate for it. Do not point this at a separate accounts subdomain unless that subdomain is the entire composed Takosumi origin for the deployment.
- `TAKOSUMI_ACCOUNTS_BIND_HOST` — the in-container Bun listener bind address. Defaults to `0.0.0.0`. Caddy reverse-proxies to `accounts:8787` on the docker-compose network, so this address is private to the container.

## Billing configuration boundary

This substrate does not parse payment-provider credentials. OSS Takosumi and
Takosumi for Operator may record disabled/showback cost evidence selected by
the operator. Checkout, enforced payment, and provider webhooks are injected by
a commercial host extension and are not part of this public distribution.

## Operator notes

- Local failed-create state recovery uses the separate
  `LocalOpenTofuStateRecoveryArtifactStore` and the file store's explicit
  `commitRecovery` and `readRecovery` capabilities. It stages bounded, operator-selected state under
  the canonical generation-one Capsule reference and verifies an immutable
  encrypted readback. Its v3 state-only envelope contains no runner result;
  ordinary v2 Apply/Destroy/Restore envelopes retain their existing semantics.
  Recovery readback caps the physical encrypted envelope at 32 MiB before
  allocation, including an occupied file with a misleading v2 prefix. The
  historical v2 reader remains uncapped for compatibility and requires a
  trusted operator-owned local filesystem; this bound is not a general file
  store guarantee.
  This is a composition library, not an enabled CLI or authenticated recovery
  route. An operator workflow must use the same control store, crypto boundary
  and artifact root as the selected deployment, authorize the exact recovery
  scope, and preserve stable retry identity and custody outside Git. See the
  [Core state contract](../../docs/internal/core-spec.md). A recovered partial
  state does not prove a complete resource inventory or provider success.
- Apply both schemas before first start: `bun run db:migrate --env=production` (control plane, reads `DATABASE_URL`)
  and `bun run cli -- accounts migrate` (accounts). The docker-compose `migrations` init container runs both for you.
  See `core/scripts/db-migrate.ts` and `cli-accounts-db.ts` for the entry points.
- A custom Node composition that supplies a durable `opentofuControlStore` to
  `buildComposedApp` or `buildComposedServer` must pass that same store to
  `createPlatformExtensionCapsulePublicOriginLedger` when it composes a
  platform-extension reservation port. Core operations and the reservation
  adapter then share the canonical Capsule lifecycle ledger; the adapter does
  not create a second store or infer a public origin.
- Operator composition remains explicit: `operatorInstallConfigs` is forwarded
  unchanged, while provider recipe drivers, the actual extension handler, and
  hostname/origin policy are supplied by the operator closure. Environment
  descriptors alone cannot create handler functions—the platform helper looks
  up the handler object at `env[handlerKey]`. The stock CLI and env-only
  reference profile therefore does not claim an end-to-end extension flow.
- A host that composes manifest-gated runtime `identity.oidc` bindings passes
  `createRuntimeInputOidcClientSource` to `buildComposedApp`/`buildComposedServer`.
  The factory receives only frozen `{ control, accounts, issuer }` wrappers:
  `control` exposes the three Capsule/InstallConfig authority reads and
  `accounts` exposes the three OIDC registration ledger methods. It does not
  receive full service operations, the Accounts store, server config, or
  secrets. The host keeps its pairwise subject secret, derivation key, and
  public-origin authority outside this factory seam.
- Operator-owned credential composition is explicit: pass the complete
  `credentialRecipes` and `credentialRecipeDrivers` together with any fixed
  `operatorProviderConnections`. A host may also supply the generic
  `runCredentialIssuer`; `allowOperatorScopedProviderConnections` defaults to
  `false` and must be explicitly enabled when those declared Connections are
  intended for Workspace bindings.
- Secrets (`POSTGRES_PASSWORD`, OAuth client secrets) belong in your operator secret store, not in the compose file. Use Docker secrets, Kubernetes Secrets, or a `.env` file outside version control.
- The Caddyfile expects `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` to resolve to the host running the stack. Caddy will obtain a Let's Encrypt cert automatically on port 80/443. The Caddyfile pins TLS to 1.2 / 1.3, emits structured JSON logs, and sets a default-deny `Content-Security-Policy` (`default-src 'self'; frame-ancestors 'none'`); override this header with the exact source allowlist your dashboard payload needs rather than removing it.

## Container hardening defaults

The compose stack runs `accounts` and `migrations` under the non-root `bun` user (uid/gid `1000:1000`) shipped by `oven/bun:1`:

- `user: "1000:1000"` on every container that runs application code.
- `cap_drop: ["ALL"]` removes every Linux capability the service grants by default.
- `security_opt: ["no-new-privileges:true"]` prevents setuid/setgid escalation.
- `accounts` mounts the root filesystem `read_only: true` with a 64 MiB tmpfs at `/tmp` for transient writes.

If you bind-mount additional directories into the `accounts` container, make sure the host path is writable by uid 1000.

## Backup and restore

- **Postgres**: stop Accounts and take a custom-format dump of the shared Accounts/control-plane database. Restore it only into a separate empty Compose project/database with `pg_restore`; do not pipe a dump into an already populated database. See the canonical [backup and recovery procedure](../../docs/self-host/backup-restore.md) for the commands, isolation checks, and verification steps. If you started Compose with a named project or extra `-f` files, use those same arguments for every backup command.
- **Caddy data** (issued certificates, OCSP staples): the `caddy-data` and `caddy-config` volumes hold ACME account state. Backing them up avoids Let's Encrypt rate-limit hits during disaster recovery, but losing them is non-fatal — Caddy will re-provision certificates on next start.

## Why two substrate references

The architectural claim that the Takosumi account plane is substrate-neutral needs a second working deployment to be more
than a spec promise. This distribution is that second working substrate for the same composed-origin account-plane
handler. See `takosumi/docs/concepts/self-host.md` and the ecosystem-level `ARCHITECTURE.md` for the substitutability
table.
