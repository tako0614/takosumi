# Takosumi Accounts — Bun + Postgres reference distribution

Substrate-neutral counterpart to `deploy/accounts-cloudflare/`. The accounts service runs on Bun against a Postgres database, fronted by Caddy for TLS. Use this when self-hosting on a VM, container host, or Kubernetes pod instead of Cloudflare.

The handler is the same `createAccountsHandler` that ships in the Cloudflare worker. Only the substrate plumbing differs:

| layer   | Cloudflare reference    | Bun + Postgres reference             |
| ------- | ----------------------- | ------------------------------------ |
| compute | Cloudflare Workers (V8) | Bun on a VM / container              |
| storage | D1 (`D1AccountsStore`)  | Postgres (`PostgresAccountsStore`)   |
| TLS     | Cloudflare edge         | Caddy automatic HTTPS                |
| secrets | `wrangler secret put`   | `.env` file or operator secret store |

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
TAKOSUMI_ACCOUNTS_ISSUER=https://accounts.example.com
TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME=accounts.example.com
TAKOSUMI_ACCOUNTS_BIND_HOST=0.0.0.0
TAKOSUMI_ACCOUNTS_CLIENT_ID=takos-app
TAKOSUMI_ACCOUNTS_REDIRECT_URIS=https://app.example.com/oauth/callback
# Stable OIDC signing key + pairwise secrets. REQUIRED for an https issuer:
# without these the service fails closed at startup rather than falling back to
# a per-process ephemeral signing key (which breaks id_token verification on
# restart / under horizontal scale). Generate a P-256 ES256 JWK with a private
# "d" coordinate; the two pairwise secrets are independent 64-char random strings.
TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK={"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}
TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET=replace-me-with-a-64-char-random-string
TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET=replace-me-with-another-64-char-random-string
```

## Files

- `src/server.ts` — Bun entry point. Uses `Bun.serve` and wires the shared accounts handler against `PostgresAccountsStore`.
- `src/handler.ts` — env parsing, mirrors the Cloudflare worker's config shape.
- `Dockerfile` — multi-stage build that installs the Bun workspace and ships a minimal Bun runtime image.
- `docker-compose.yml` — Postgres + accounts + Caddy stack.
- `Caddyfile.example` — reverse proxy + automatic HTTPS template.

## Listener vs. public hostname

The Caddy site label and the Bun listener bind address are intentionally separate env vars:

- `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` — the eTLD+1 your users dial (e.g. `accounts.example.com`). Caddy uses this as the site label in `Caddyfile.example` and obtains an ACME certificate for it.
- `TAKOSUMI_ACCOUNTS_BIND_HOST` — the in-container Bun listener bind address. Defaults to `0.0.0.0`. Caddy reverse-proxies to `accounts:8787` on the docker-compose network, so this address is private to the container.

The legacy `TAKOSUMI_ACCOUNTS_HOSTNAME` env var is accepted as a deprecated alias for `TAKOSUMI_ACCOUNTS_BIND_HOST` to ease upgrades. New deployments must use the split env names.

## Installation export downloads

To enable installation export downloads the operator must set, together:

- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` — long-lived HMAC secret used to sign and verify the time-limited export download URLs. The export worker signs each emitted URL (`tk_exp` expiry + `tk_sig` HMAC-SHA256 query params), mirroring the Cloudflare profile.
- `TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR` — filesystem directory where `takos-export-<op>.tar.zst[.age]` archives are materialized.
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL` — public URL prefix the signed download URLs are built under. Point it at this server (so the in-process route verifies the signature before serving) or at a static file server in front of `EXPORT_OUTPUT_DIR`.
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS` (optional) — TTL for the signed download URL. Defaults to 24h.

The export worker writes archives to the local filesystem. The shipped `docker-compose.yml` mounts a writable `exports-data` named volume at the default `EXPORT_OUTPUT_DIR` (`/var/lib/takosumi-accounts/exports`) so the export worker can write under the container's `read_only: true` root filesystem. If you change `EXPORT_OUTPUT_DIR`, change that mount too (or bind-mount a writable host directory).

When `EXPORT_DOWNLOAD_BASE_URL` points at this server, the `accounts` service handles the download path itself and verifies the HMAC signature + expiry fail-closed (invalid signature → 403, expired → 410) before reading the archive off disk; a basename-only file resolution prevents path traversal. When it instead points at an external static server, the signature + expiry are still embedded in the URL (unguessable, time-limited) but enforcement is the static server's responsibility.

## Stripe billing

`TAKOSUMI_ACCOUNTS_STRIPE_PUBLIC_KEY` (publishable key, `pk_live_...` or `pk_test_...`) is parsed for completeness but **not** forwarded into `StripeBillingOptions`; the upstream `@takosjp/takosumi-accounts-service` type only carries the secret key + webhook secret. Publishable keys are surfaced to dashboards / SDKs through the separate dashboard-config plumbing in the operator distribution.

## Operator notes

- Run `bun packages/cli/src/main.ts accounts migrate` against Postgres before first start, or use the docker-compose `migrations` init container which does it for you. See `cli-accounts-db.ts` for the migration entry point.
- Secrets (`POSTGRES_PASSWORD`, OAuth client secrets) belong in your operator secret store, not in the compose file. Use Docker secrets, Kubernetes Secrets, or a `.env` file outside version control.
- Managed offering access defaults to `closed`. Set `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS=open` plus the readiness digest after launch readiness evidence is in place.
- The Caddyfile expects `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` to resolve to the host running the stack. Caddy will obtain a Let's Encrypt cert automatically on port 80/443. The Caddyfile pins TLS to 1.2 / 1.3, emits structured JSON logs, and sets a default-deny `Content-Security-Policy` (`default-src 'self'; frame-ancestors 'none'`); override this header with the exact source allowlist your dashboard payload needs rather than removing it.

## Container hardening defaults

The compose stack runs `accounts` and `migrations` under the non-root `bun` user (uid/gid `1000:1000`) shipped by `oven/bun:1`:

- `user: "1000:1000"` on every container that runs application code.
- `cap_drop: ["ALL"]` removes every Linux capability the kernel grants by default.
- `security_opt: ["no-new-privileges:true"]` prevents setuid/setgid escalation.
- `accounts` mounts the root filesystem `read_only: true` with a 64 MiB tmpfs at `/tmp` for transient writes.

If you bind-mount additional directories into the `accounts` container (e.g. the export output directory) make sure the host path is writable by uid 1000.

## Backup and restore

- **Postgres**: snapshot the `postgres-data` volume with `docker compose exec postgres pg_dump -U takosumi takosumi_accounts | gzip > backup-$(date +%Y%m%d).sql.gz`, and store the archive in your operator backup target. Restore with `gunzip -c backup-...sql.gz | docker compose exec -T postgres psql -U takosumi takosumi_accounts`. The migration init container is idempotent and safe to re-run after restore.
- **Caddy data** (issued certificates, OCSP staples): the `caddy-data` and `caddy-config` volumes hold ACME account state. Backing them up avoids Let's Encrypt rate-limit hits during disaster recovery, but losing them is non-fatal — Caddy will re-provision certificates on next start.
- **Export archives**: `TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR` is a per-deploy artifact directory. Treat it as ephemeral; archives are reproducible by re-running the export operation from the dashboard.

## Why two reference distributions

The architectural claim that Takosumi Accounts is substrate-neutral needs a second working deployment to be more than a spec promise. This distribution is that second working deployment. See `docs/architecture/takosumi.md` and the ecosystem-level `ARCHITECTURE.md` for the substitutability table.
