# Takosumi Account Plane — Bun + Postgres substrate

Substrate-neutral counterpart to `deploy/accounts-cloudflare/`. The account-plane handler runs on Bun against a Postgres database, fronted by Caddy for TLS. Use this when the composed Takosumi origin is hosted on a VM, container host, or Kubernetes pod instead of Cloudflare.

The handler is the same `createAccountsHandler` mounted in the platform worker. Only the substrate plumbing differs:

| layer   | Cloudflare reference    | Bun + Postgres reference             |
| ------- | ----------------------- | ------------------------------------ |
| compute | Cloudflare Workers (V8) | Bun on a VM / container              |
| storage | D1 (`D1AccountsStore`)  | Postgres (`PostgresAccountsStore`)   |
| TLS     | Cloudflare edge         | Caddy automatic HTTPS                |
| secrets | `wrangler secret put`   | `.env` file or operator secret store |

The account plane is the backing layer for session cookies, upstream sign-in, the bare-origin OIDC issuer, dashboard
account records, session/OIDC/PAT state, and the dashboard facade. It is mounted on the same composed Takosumi origin as
the dashboard and control plane; it is not a second control plane and does not require a dedicated accounts subdomain.
Workspace / Project / Capsule / Run / StateVersion / Output resources are created and read through the control-plane
surface. Accounts does not maintain a second Capsule/runtime or Run/Output ledger;
runtime contracts are canonical Interface / InterfaceBinding records.

## Quick start

```bash
cd deploy/node-postgres
cp .env.example .env  # then edit
docker compose up -d
curl -k https://localhost/.well-known/openid-configuration
```

Required `.env`:

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
TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS={"keys":[{"kty":"EC","crv":"P-256","kid":"previous-key","x":"...","y":"..."}]}
TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET=replace-me-with-a-64-char-random-string
```

For a Takos native shell, register a separate host-specific public client in
`TAKOSUMI_ACCOUNTS_CLIENTS`. Its `redirectUris` entry must be exactly
`takos://oauth/callback`, `tokenEndpointAuthMethod` must be `none`, and
`allowedScopes` must list only the Takos mobile API scopes the shell uses. Set
the same `clientId` as `OIDC_MOBILE_CLIENT_ID` on that Takos Worker. Do not put a
client secret in the app or reuse the browser client's id.

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

- Run `bun run cli -- accounts migrate` against Postgres before first start, or use the docker-compose `migrations`
  init container which does it for you. See `cli-accounts-db.ts` for the migration entry point.
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

- **Postgres**: snapshot the `postgres-data` volume with `docker compose exec postgres pg_dump -U takosumi takosumi_accounts | gzip > backup-$(date +%Y%m%d).sql.gz`, and store the archive in your operator backup target. Restore with `gunzip -c backup-...sql.gz | docker compose exec -T postgres psql -U takosumi takosumi_accounts`. The migration init container is idempotent and safe to re-run after restore.
- **Caddy data** (issued certificates, OCSP staples): the `caddy-data` and `caddy-config` volumes hold ACME account state. Backing them up avoids Let's Encrypt rate-limit hits during disaster recovery, but losing them is non-fatal — Caddy will re-provision certificates on next start.

## Why two substrate references

The architectural claim that the Takosumi account plane is substrate-neutral needs a second working deployment to be more
than a spec promise. This distribution is that second working substrate for the same composed-origin account-plane
handler. See `takosumi/docs/reference/operator.md` and the ecosystem-level `ARCHITECTURE.md` for the substitutability
table.
