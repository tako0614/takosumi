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
account records, Capsule projection metadata, and export handoff. It is mounted on the same composed Takosumi origin as
the dashboard and control plane; it is not a second control plane and does not require a dedicated accounts subdomain.
Workspace / Project / Capsule / Run / StateVersion / Output resources are created and read through the control-plane
surface. The current `/v1/capsule-projections` route is a compatibility projection path for older installed-service
clients and must map back to Capsule / Output / account-plane evidence in public docs.

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
# "d" coordinate; the two pairwise secrets are independent 64-char random strings.
TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK={"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}
TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS={"keys":[{"kty":"EC","crv":"P-256","kid":"previous-key","x":"...","y":"..."}]}
TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET=replace-me-with-a-64-char-random-string
TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET=replace-me-with-another-64-char-random-placeholder
```

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

## Export downloads

Export downloads are portability/import artifacts owned by the account-plane projection flow. They are not the operator
backup/restore mechanism for the Takosumi control ledger, StateVersion records, Output records, or raw state artifacts.

To enable export downloads the operator must set, together:

- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` — long-lived HMAC secret used to sign and verify the time-limited export download URLs. The export worker signs each emitted URL (`tk_exp` expiry + `tk_sig` HMAC-SHA256 query params), mirroring the Cloudflare profile.
- `TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR` — filesystem directory where `takos-export-<op>.tar.zst[.age]` archives are materialized.
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL` — public URL prefix the signed download URLs are built under. Use an HTTPS URL in operator environments, or loopback `http://localhost` / `http://127.0.0.1` only for local development. Point it at this server so the in-process route verifies the signature before serving.
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS` (optional) — TTL for the signed download URL. Defaults to 24h.

The export worker writes archives to the local filesystem. The shipped `docker-compose.yml` mounts a writable `exports-data` named volume at the default `EXPORT_OUTPUT_DIR` (`/var/lib/takosumi-accounts/exports`) so the export worker can write under the container's `read_only: true` root filesystem. If you change `EXPORT_OUTPUT_DIR`, change that mount too (or bind-mount a writable host directory).

When `EXPORT_DOWNLOAD_BASE_URL` points at this server, the `accounts` service handles the download path itself and verifies the HMAC signature + expiry fail-closed (invalid signature → 403, expired → 410) before reading the archive off disk; a basename-only file resolution prevents path traversal. Do not point export downloads at an unauthenticated static directory: the service-owned verifier is the security boundary for export artifacts.

Completed export operations include `archiveDigest` (`sha256:<hex>`) computed from the final `takos-export-<op>.tar.zst[.age]` artifact. Use that value as the `encrypted-export.archiveDigest` launch-readiness evidence; do not recompute it from a download URL or unsigned object-store metadata.

## Billing configuration boundary

`TAKOSUMI_ACCOUNTS_STRIPE_PUBLIC_KEY` (publishable key, `pk_live_...` or `pk_test_...`) is parsed for compatibility with
older account-plane configuration, but this substrate does not make official billing an OSS feature. OSS Takosumi and
Takosumi for Operators may record disabled/showback quota evidence selected by the operator. Official billing,
payment-processor checkout, usage metering sold as a service, support, and abuse workflows are Takosumi Cloud-only
closed features and should be configured through Cloud/private deployment plumbing, not treated as part of this public
distribution.

## Operator notes

- Run `bun run cli -- accounts migrate` against Postgres before first start, or use the docker-compose `migrations`
  init container which does it for you. See `cli-accounts-db.ts` for the migration entry point.
- Secrets (`POSTGRES_PASSWORD`, OAuth client secrets) belong in your operator secret store, not in the compose file. Use Docker secrets, Kubernetes Secrets, or a `.env` file outside version control.
- hosted Takosumi access defaults to `closed`. Set `TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS=open` only after launch
  readiness evidence and production hardening evidence are in place. The node-postgres distribution mirrors the
  Cloudflare worker gate: open access requires the readiness digest, evidence/approval refs, reviewed public summary,
  `TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce`, and the container / layer-2 platform-control-plane smoke / egress /
  restore rehearsal / ProviderConnection / CredentialRecipe / ProviderBinding / cost-showback / secret-boundary
  evidence refs and digests.
- The Caddyfile expects `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` to resolve to the host running the stack. Caddy will obtain a Let's Encrypt cert automatically on port 80/443. The Caddyfile pins TLS to 1.2 / 1.3, emits structured JSON logs, and sets a default-deny `Content-Security-Policy` (`default-src 'self'; frame-ancestors 'none'`); override this header with the exact source allowlist your dashboard payload needs rather than removing it.

## Container hardening defaults

The compose stack runs `accounts` and `migrations` under the non-root `bun` user (uid/gid `1000:1000`) shipped by `oven/bun:1`:

- `user: "1000:1000"` on every container that runs application code.
- `cap_drop: ["ALL"]` removes every Linux capability the service grants by default.
- `security_opt: ["no-new-privileges:true"]` prevents setuid/setgid escalation.
- `accounts` mounts the root filesystem `read_only: true` with a 64 MiB tmpfs at `/tmp` for transient writes.

If you bind-mount additional directories into the `accounts` container (e.g. the export output directory) make sure the host path is writable by uid 1000.

## Backup and restore

- **Postgres**: snapshot the `postgres-data` volume with `docker compose exec postgres pg_dump -U takosumi takosumi_accounts | gzip > backup-$(date +%Y%m%d).sql.gz`, and store the archive in your operator backup target. Restore with `gunzip -c backup-...sql.gz | docker compose exec -T postgres psql -U takosumi takosumi_accounts`. The migration init container is idempotent and safe to re-run after restore.
- **Caddy data** (issued certificates, OCSP staples): the `caddy-data` and `caddy-config` volumes hold ACME account state. Backing them up avoids Let's Encrypt rate-limit hits during disaster recovery, but losing them is non-fatal — Caddy will re-provision certificates on next start.
- **Export archives**: `TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR` is a per-deploy artifact directory. Treat it as ephemeral; archives are reproducible by re-running the export operation from the dashboard.

## Why two substrate references

The architectural claim that the Takosumi account plane is substrate-neutral needs a second working deployment to be more
than a spec promise. This distribution is that second working substrate for the same composed-origin account-plane
handler. See `takosumi/docs/reference/operator.md` and the ecosystem-level `ARCHITECTURE.md` for the substitutability
table.
