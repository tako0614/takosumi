# Takosumi Cloudflare deploy runbook

Single entry point for deploying the two Takosumi-public properties to Cloudflare. Each section is self-contained: prerequisites, one-time setup, deploy command, smoke check.

| Property             | Resource type               | Project / Worker name     | Source                              |
| -------------------- | --------------------------- | ------------------------- | ----------------------------------- |
| `takosumi.com`       | Cloudflare Pages            | `takosumi-website`        | `takosumi/website/` (merged build)  |
| `cloud.takosumi.com` | Cloudflare Worker + D1 + R2 | `takosumi-cloud-accounts` | `takosumi-cloud/deploy/cloudflare/` |

> **Wave M-G (= 2026-05-20) architectural restructure**: the `takosumi.com` Pages project now serves the **whole property** — landing at `/`, VitePress reference docs at `/docs/*`, and the JSON-LD context catalog at `/contexts/*` — from a single deploy. The previous split into two Pages projects (`takosumi-site` minimal HTML landing, and `takosumi-docs` standalone `docs.takosumi.com` subdomain) is superseded. See [§Cleanup of legacy Pages projects](#cleanup-of-legacy-pages-projects) for the one-time operator-side dashboard cleanup.

## One-time operator prerequisites

1. Cloudflare account with the `takosumi.com` zone added (DNS hosted on Cloudflare).
2. `wrangler` installed and authenticated:
   ```sh
   npx wrangler login
   ```
   Or set the env vars `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` for non-interactive deploys (CI). The token needs: Workers Scripts:Edit, Workers Routes:Edit, D1:Edit, Pages:Edit, Account Settings:Read.

DNS records for `takosumi.com`, `www.takosumi.com` and `cloud.takosumi.com` are created automatically when you attach each custom domain in the Cloudflare dashboard (Pages → Custom domains or Workers → Custom domains).

---

## 1. `takosumi.com` — website (landing + /docs/ + /contexts/, Cloudflare Pages)

**Source**: `takosumi/website/` (Solid Start landing) + `takosumi/docs/` (VitePress reference docs, base `/docs/`) + `takosumi/spec/contexts/` (JSON-LD context under `/contexts/`) + `takosumi/packages/plugins/spec/kinds/v1/` (official kind schemas under `/kinds/v1/`).

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
└── kinds/v1/                  # Kind Catalog descriptors
    ├── v1.jsonld
    └── kinds/v1/<name>.jsonld
```

One-time setup:

```sh
cd takosumi
deno task docs:install              # installs vitepress under docs/node_modules
(cd website && npm install)          # installs solid start + vinxi under website/node_modules
npx wrangler pages project create takosumi-website \
  --production-branch=main
# In dashboard:
#   Workers & Pages → takosumi-website → Custom domains
#   Add `takosumi.com`
#   (optional) Add `www.takosumi.com`
```

Deploy:

```sh
cd takosumi
deno task website:deploy
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

## 2. `cloud.takosumi.com` — Takosumi Accounts (Cloudflare Worker + D1 + R2)

**Source**: `takosumi-cloud/deploy/cloudflare/` (worker + wrangler.toml).

One-time setup:

```sh
cd takosumi-cloud
# Create the D1 database
npx wrangler d1 create takosumi-cloud-accounts
# Copy the returned UUID into deploy/cloudflare/wrangler.toml's
# `database_id` field (replacing the all-zeros placeholder).

# Create the R2 bucket for metadata-only AppInstallation export artifacts.
npx wrangler r2 bucket create takosumi-cloud-accounts-exports

# Push secrets (replace each value with the real secret on prompt)
npx wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK \
  --config deploy/cloudflare/wrangler.toml
npx wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET \
  --config deploy/cloudflare/wrangler.toml
npx wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET \
  --config deploy/cloudflare/wrangler.toml
npx wrangler secret put TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET \
  --config deploy/cloudflare/wrangler.toml
# Optional: Stripe / passkey / upstream OIDC / OIDC client secret

# In dashboard:
#   Workers & Pages → takosumi-cloud-accounts → Triggers → Custom Domains
#   Add `cloud.takosumi.com`
# (The [[routes]] block in wrangler.toml binds the worker; the
#  dashboard step wires DNS + TLS.)
```

Generate an ES256 private JWK with one of:

```sh
deno run -A jsr:@takos/takosumi-cloud-accounts-service/scripts/gen-jwk   # if present
# or any tool that emits {kty:"EC", crv:"P-256", d, x, y}
```

Deploy:

```sh
cd takosumi-cloud
deno task deploy:cloudflare:dryrun   # validates bindings + env, no upload
deno task deploy:cloudflare          # actual deploy
```

Smoke:

```sh
curl https://cloud.takosumi.com/healthz
# {"ok":true,"provider":"cloudflare","service":"takosumi-cloud-accounts","persistence":"d1+r2"}

curl https://cloud.takosumi.com/.well-known/openid-configuration | jq .issuer
# "https://cloud.takosumi.com"
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

After cleanup, the only Takosumi-public Cloudflare resources are `takosumi-website` (this runbook §1) and `takosumi-cloud-accounts` (§2).

---

## Updating downstream consumers

When `cloud.takosumi.com` is live, downstream products that consume Takosumi Accounts need to point at it:

- `takos-private/apps/control/cloudflare/wrangler.toml` — `OIDC_ISSUER_URL = "https://cloud.takosumi.com"` (already set by this deploy plan in both production and staging blocks).
- Any other operator profile that maintains its own OIDC client registration with Takosumi Accounts must update its issuer URL.

The OIDC client `takos-private-production` is registered with the Worker via the `TAKOSUMI_ACCOUNTS_CLIENT_ID` / `TAKOSUMI_ACCOUNTS_REDIRECT_URIS` vars in `takosumi-cloud/deploy/cloudflare/wrangler.toml`. Update there if the takos.jp callback URI changes.

## Rolling back

- **Pages** (`takosumi.com`): redeploy the previous git commit via `deno task website:deploy`. Cloudflare Pages also keeps deployment history in the dashboard for one-click rollback. Rolling back the website also rolls back `/docs/` and `/contexts/` because they ship from the same Pages artifact.
- **Worker** (`cloud.takosumi.com`): `wrangler rollback` or redeploy the previous commit. D1 state is preserved across rollbacks.

## CI

`.github/workflows/website-deploy.yml` builds and pushes the merged Pages artifact on `master` (or via manual dispatch). Push-to-deploy for the Accounts Worker is intentionally not wired here — operators run the deno tasks from a workstation. To add GitHub Actions later for the Worker, wrap the same `takosumi-cloud` tasks with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exposed as repo secrets; the deploy commands themselves do not change.
