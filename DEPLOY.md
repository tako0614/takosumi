# Takosumiflare deploy runbook

Single entry point for deploying the two Takosumi-public properties to Cloudflare. Each section is self-contained: prerequisites, one-time setup, deploy command, smoke check.

| Property             | Resource type               | Project / Worker name     | Source                              |
| -------------------- | --------------------------- | ------------------------- | ----------------------------------- |
| `takosumi.com`       | Cloudflare Pages            | `takosumi-website`        | `takosumi/website/` (merged build)  |
| `accounts.takosumi.com` | Cloudflare Worker + D1 + R2 | `takosumi-accounts` | `takosumi/deploy/accounts-cloudflare/` |

> **Wave M-G (= 2026-05-20) architectural restructure**: the `takosumi.com` Pages project now serves the **whole property** — landing at `/`, VitePress reference docs at `/docs/*`, and the JSON-LD context catalog at `/contexts/*` — from a single deploy. The previous split into two Pages projects (`takosumi-site` minimal HTML landing, and `takosumi-docs` standalone `docs.takosumi.com` subdomain) is superseded. See [§Cleanup of legacy Pages projects](#cleanup-of-legacy-pages-projects) for the one-time operator-side dashboard cleanup.

## One-time operator prerequisites

1. Cloudflare account with the `takosumi.com` zone added (DNS hosted on Cloudflare).
2. `wrangler` installed and authenticated:
   ```sh
   bunx wrangler login
   ```
   Or set the env vars `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` for non-interactive deploys (CI). The token needs: Workers Scripts:Edit, Workers Routes:Edit, D1:Edit, Pages:Edit, Account Settings:Read.

DNS records for `takosumi.com`, `www.takosumi.com` and `accounts.takosumi.com` are created automatically when you attach each custom domain in the Cloudflare dashboard (Pages → Custom domains or Workers → Custom domains).

---

## 1. `takosumi.com` — website (landing + /docs/ + /contexts/, Cloudflare Pages)

**Source**: `takosumi/website/` (Solid Start landing) + `takosumi/docs/` (VitePress reference docs, base `/docs/`) + `takosumi/spec/contexts/` (JSON-LD context under `/contexts/`) + `takosumi/docs/kinds/v1/*.jsonld` (official kind schemas under `/kinds/v1/`).

`website/build.sh` produces the merged `.output/public/` artifact:

```
website/.output/public/
├── index.html                 # Solid Start landing (apex)
├── assets/, brand/, ...       # landing static assets
├── docs/                      # VitePress build (base = "/docs/")
│   ├── index.html
│   ├── reference/, getting-started/, operator/, ...
│   └── ...
├── contexts/                  # JSON-LD context
└── kinds/v1/                  # Official Type Catalog descriptors
    ├── <name>
    └── <name>.jsonld
```

One-time setup:

```sh
cd takosumi
npm --prefix docs install           # installs vitepress under docs/node_modules
(cd website && npm install)          # installs solid start + vinxi under website/node_modules
bunx wrangler pages project create takosumi-website \
  --production-branch=main
# In dashboard:
#   Workers & Pages → takosumi-website → Custom domains
#   Add `takosumi.com`
#   (optional) Add `www.takosumi.com`
```

Deploy:

```sh
cd takosumi
bash website/build.sh
wrangler pages deploy website/.output/public --project-name=takosumi-website
```

Smoke:

```sh
curl -I https://takosumi.com/                                # 200
curl https://takosumi.com/ | head                             # landing
curl -I https://takosumi.com/docs/                            # 200
curl https://takosumi.com/docs/reference/architecture/         # links resolve
curl https://takosumi.com/contexts/v1.jsonld | jq '.["@context"]["@vocab"]'
# "https://takosumi.com/"
```

---

## 2. `accounts.takosumi.com` — Takosumi Accounts (Cloudflare Worker + D1 + R2)

**Source**: `takosumi/deploy/accounts-cloudflare/` (worker + wrangler.toml).

One-time setup:

```sh
cd takosumi
# Create the D1 database
bunx wrangler d1 create takosumi-accounts
# Copy the returned UUID into deploy/accounts-cloudflare/wrangler.toml's
# `database_id` field (replacing the all-zeros placeholder).

# Create the R2 bucket for metadata-only AppInstallation export artifacts.
bunx wrangler r2 bucket create takosumi-accounts-exports

# Push secrets (replace each value with the real secret on prompt)
bunx wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
# Optional: Stripe / passkey / upstream OIDC / OIDC client secret

# In dashboard:
#   Workers & Pages → takosumi-accounts → Triggers → Custom Domains
#   Add `accounts.takosumi.com`
# (The [[routes]] block in wrangler.toml binds the worker; the
#  dashboard step wires DNS + TLS.)
```

Generate an ES256 private JWK with any operator-approved tool that emits
`{ kty: "EC", crv: "P-256", d, x, y }`.

Deploy:

```sh
cd takosumi
bun run deploy:accounts-cloudflare:dryrun   # validates bindings + env, no upload
bun run deploy:accounts-cloudflare          # actual deploy
```

Smoke:

```sh
curl https://accounts.takosumi.com/healthz
# {"ok":true,"provider":"cloudflare","service":"takosumi-accounts","persistence":"d1+r2"}

curl https://accounts.takosumi.com/.well-known/openid-configuration | jq .issuer
# "https://accounts.takosumi.com"
```

---

## Cleanup of legacy Pages projects

Wave M-G (2026-05-20) consolidated `takosumi-site` (vanilla HTML landing at the apex) and `takosumi-docs` (VitePress at the `docs.takosumi.com` subdomain) into the single `takosumi-website` Pages project deployed in §1 above. The two legacy projects and the `docs.takosumi.com` custom domain must be removed by hand from the Cloudflare dashboard — `wrangler pages` does not support deleting projects or custom domains, and this commit intentionally does not embed account-side mutations.

Do this **after** `takosumi-website` is verified live at the apex and at `/docs/`:

1. **Detach the `docs.takosumi.com` custom domain**:
   - Workers & Pages → `takosumi-docs` → Custom domains → `docs.takosumi.com` → Remove. Confirm the DNS record (CNAME at `docs`) is also removed from the `takosumi.com` zone if Cloudflare left a stale entry.
2. **Delete the `takosumi-docs` Pages project**:
   - Workers & Pages → `takosumi-docs` → Settings → Delete project. This stops the production deployment on the default `*.pages.dev` host as well.
3. **Detach the apex from `takosumi-site` (if previously deployed)**:
   - Workers & Pages → `takosumi-site` → Custom domains → `takosumi.com` and `www.takosumi.com` → Remove. Re-attach them to `takosumi-website` before the deploy in §1 so `takosumi.com/` flips to the new build without downtime. (If `takosumi.com` was never attached to `takosumi-site` because it was a fresh deploy, skip this step.)
4. **Delete the `takosumi-site` Pages project**:
   - Workers & Pages → `takosumi-site` → Settings → Delete project.

DNS for `docs.takosumi.com` should now resolve to NXDOMAIN once Cloudflare prunes the proxied record. Verify with:

```sh
dig docs.takosumi.com   # expect NXDOMAIN
curl -I https://takosumi.com/docs/    # 200 (served by takosumi-website)
```

After cleanup, the only Takosumi-public Cloudflare resources are `takosumi-website` (this runbook §1) and `takosumi-accounts` (§2).

---

## Updating downstream consumers

When `accounts.takosumi.com` is live, downstream products that consume Takosumi Accounts need to point at it:

- `takos-private/apps/control/cloudflare/wrangler.toml` — `OIDC_ISSUER_URL = "https://accounts.takosumi.com"` (already set by this deploy plan in both production and staging blocks).
- Any other operator distribution that maintains its own OIDC client registration with Takosumi Accounts must update its issuer URL.

The OIDC client `takos-private-production` is registered with the Worker via the `TAKOSUMI_ACCOUNTS_CLIENT_ID` / `TAKOSUMI_ACCOUNTS_REDIRECT_URIS` vars in `takosumi/deploy/accounts-cloudflare/wrangler.toml`. Update there if the takos.jp callback URI changes.

## Rolling back

- **Pages** (`takosumi.com`): redeploy the previous git commit with `bash website/build.sh` and `wrangler pages deploy website/.output/public --project-name=takosumi-website`. Cloudflare Pages also keeps deployment history in the dashboard for one-click rollback. Rolling back the website also rolls back `/docs/` and `/contexts/` because they ship from the same Pages artifact.
- **Worker** (`accounts.takosumi.com`): `wrangler rollback` or redeploy the previous commit. D1 state is preserved across rollbacks.

## CI

`.github/workflows/website-deploy.yml` builds and pushes the merged Pages artifact on `master` (or via manual dispatch). Push-to-deploy for the Accounts Worker is intentionally not wired here — operators run the Bun deploy tasks from a workstation. To add GitHub Actions later for the Worker, wrap the same `takosumi` tasks with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exposed as repo secrets; the deploy commands themselves do not change.
