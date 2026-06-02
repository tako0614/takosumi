# Production deploy to Cloudflare (takosumi.com / accounts.takosumi.com)

The local-substrate mirrors production using `.test` TLDs:

| Production                                 | Local mirror                           | Backend                                                                     |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| `https://takosumi.com/`                    | `https://takosumi.test/`               | Cloudflare Pages (prod) / Caddy file_server (local)                         |
| `https://accounts.takosumi.com/`              | `https://accounts.takosumi.test/`         | Accounts Cloudflare Worker + D1 + R2 (prod) / Miniflare + SQLite/R2 (local) |
| operator-selected Takosumi service hostname | `https://service-worker.takosumi.test/` | Takosumi service Worker + D1/R2/Queues/DO (prod) / Miniflare local binds     |

Once the local mirror passes `scripts/smoke.sh`, follow this runbook to push the same artifacts to real Cloudflare. The Worker code is byte-for- byte identical; only DNS / binding IDs / secrets differ.

## Prerequisites

1. **Domain ownership**: `takosumi.com` registered, DNS delegated to Cloudflare nameservers.
2. **Cloudflare account** with the `takosumi.com` zone added.
3. **API token** with: `Workers Scripts:Edit`, `Workers Routes:Edit`, `D1:Edit`, `R2:Edit`, `Queues:Edit`, `Pages:Edit`, `DNS:Edit` for `takosumi.com`. The Pages permission must cover writes to the single `takosumi-website` project (post Wave M-G consolidation; see §Step 3).
4. **wrangler** installed (`npm install -g wrangler` or `npx wrangler`).
5. **Logged in**: `wrangler login` once.

## Step 1 — takosumi Worker (accounts.takosumi.com)

```sh
cd takosumi/

# Create D1 database and capture the UUID it returns.
wrangler d1 create takosumi-accounts
# → "database_id": "abcd1234-..."
# Paste the UUID into deploy/cloudflare/wrangler.toml's [[d1_databases]]
# database_id field, replacing the all-zeros placeholder.

# Create the R2 bucket for metadata-only AppInstallation export artifacts.
wrangler r2 bucket create takosumi-accounts-exports

# Push secrets (interactive prompts).
wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK    --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET --config deploy/cloudflare/wrangler.toml
# (Stripe / upstream OIDC / passkey secrets if used)

# Deploy.
wrangler deploy --config deploy/cloudflare/wrangler.toml
```

The `[[routes]]` block in `wrangler.toml` already maps `accounts.takosumi.com/*` to this Worker. Cloudflare auto-creates the DNS record on first deploy as long as the zone is in your account.

Verify:

```sh
curl https://accounts.takosumi.com/.well-known/openid-configuration
```

## Step 2 — Takosumi service Worker

The Takosumi service Worker is owned by `takosumi/deploy/cloudflare/`. It is Worker-first and uses Cloudflare bindings directly: D1 for service snapshots / Installation and Deployment records, R2 for artifacts, Queues for enqueue, and Durable Objects for coordination.

```sh
cd takosumi/

# Create backing resources and paste returned identifiers into deploy/cloudflare/wrangler.toml.
wrangler d1 create takosumi
wrangler r2 bucket create takos-artifacts
wrangler queues create takosumi-control-plane
wrangler queues create takosumi-control-plane-dlq

# Push operator secrets.
wrangler secret put TAKOSUMI_INSTALLER_TOKEN --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_DEPLOY_TOKEN --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_INTERNAL_API_SECRET --config deploy/cloudflare/wrangler.toml
wrangler secret put TAKOSUMI_SECRET_STORE_PASSPHRASE --config deploy/cloudflare/wrangler.toml

# Optional if provider apply should call a runtime-agent from the Worker.
wrangler secret put TAKOSUMI_AGENT_TOKEN --config deploy/cloudflare/wrangler.toml

# Deploy.
wrangler deploy --config deploy/cloudflare/wrangler.toml
```

Add the operator-owned route or custom domain for the service Worker in Cloudflare after choosing the public/private API hostname. The local-substrate intentionally exposes the mirror as `service-worker.takosumi.test` so it can be checked beside the default Bun+Postgres service at `service.takosumi.test`.

Verify:

```sh
curl https://<service-host>/healthz
curl https://<service-host>/storage/healthz
curl https://<service-host>/coordination/healthz
curl -X POST -H "Content-Type: application/json" \
  -d '{"kind":"smoke"}' \
  https://<service-host>/queue/test
```

## Step 3 — takosumi.com website (landing + /docs/ + /contexts/, Cloudflare Pages)

Wave M-G (= 2026-05-20) consolidated the apex landing, the VitePress reference docs, and the JSON-LD context catalog into a **single** Cloudflare Pages project (`takosumi-website`). The build script `takosumi/website/build.sh` produces one merged `.output/public/` artifact with `index.html` at the apex, the VitePress build overlaid under `/docs/`, and `spec/contexts/` overlaid under `/contexts/`. The legacy split (`takosumi-site` for the landing + `takosumi-docs` for `docs.takosumi.com`) is superseded; see [`takosumi/DEPLOY.md`](../../../DEPLOY.md) §"Cleanup of legacy Pages projects" for the one-time dashboard cleanup steps.

Option A — connect Pages to the takosumi repo (recommended for CI):

1. Cloudflare dashboard → Pages → Create Project → Connect to Git.
2. Build settings:
   - Build command: `bash website/build.sh`
   - Build output directory: `website/.output/public`
   - Root directory: (repo root)
3. Custom domain: `takosumi.com` (apex), optionally `www.takosumi.com`. Pages provisions cert.

Option B — `wrangler pages deploy` (one-shot from your laptop):

```sh
cd takosumi
cd takosumi/docs && bun install      # installs vitepress
(cd website && npm install)           # installs solid start + vinxi
bun run website:deploy                # runs build.sh + wrangler pages deploy
# Then in dashboard, add takosumi.com (and optionally www.takosumi.com)
# as custom domains on the takosumi-website project.
```

Verify:

```sh
curl -I https://takosumi.com/                  # 200 (landing)
curl -I https://takosumi.com/docs/             # 200 (VitePress)
curl https://takosumi.com/contexts/v1.jsonld   # JSON-LD vocab
```

## Step 4 — DNS sanity

In the `takosumi.com` Cloudflare zone you should now have:

| Type              | Name                     | Target                         | Proxied                                                                                      |
| ----------------- | ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `A` / Pages route | `@` (takosumi.com)       | (managed by Pages)             | yes                                                                                          |
| Worker route      | `accounts.takosumi.com`     | takosumi-accounts Worker | (no DNS record needed for `*.com/*` Worker routes — Cloudflare matches on the route pattern) |
| Worker route      | operator service hostname | takosumi service Worker         | choose operator-owned public/private hostname and route policy                               |

If using a separate CNAME for `accounts.takosumi.com`, add it pointing anywhere — the Worker route intercepts before DNS resolution matters.

## Rollback

```sh
# Accounts Worker
wrangler rollback --config takosumi/deploy/cloudflare/wrangler.toml

# Service Worker
wrangler rollback --config takosumi/deploy/cloudflare/wrangler.toml

# Pages
# Use the dashboard to redeploy a previous build.
```

## Why the local mirror is a faithful test

The local-substrate runs the **same bundled Worker files** that `wrangler deploy` ships:

```
takosumi/deploy/cloudflare/.wrangler/dist/takosumi-accounts-worker.mjs
takosumi/deploy/cloudflare/.wrangler/dist/takosumiflare-worker.mjs
```

The build containers produce them; Miniflare runs them locally with emulated D1/R2/Queues/DO bindings. The difference between local and prod is the provider-managed binding backend and the binding / secret values. Code path is identical.

If `accounts.takosumi.test/.well-known/openid-configuration` returns 200 in local-substrate, the same Worker route should work on `accounts.takosumi.com` only after Cloudflare-side DNS/TLS, route, D1/R2 binding IDs, and secrets are validated and recorded as launch-readiness evidence. If `service-worker.takosumi.test/{healthz,storage/healthz,coordination/healthz,queue/test}` passes locally, the service Worker bundle has booted with the same Cloudflare binding contract that production uses.
