# Takosumi Cloudflare deploy runbook

Single entry point for deploying the three Takosumi-public properties
to Cloudflare. Each section is self-contained: prerequisites, one-time
setup, deploy command, smoke check.

| Property              | Resource type            | Project / Worker name        | Source                            |
| --------------------- | ------------------------ | ---------------------------- | --------------------------------- |
| `takosumi.com`        | Cloudflare Pages         | `takosumi-site`              | `takosumi/site/`                  |
| `docs.takosumi.com`   | Cloudflare Pages         | `takosumi-docs`              | `takosumi/docs/` (VitePress)      |
| `cloud.takosumi.com`  | Cloudflare Worker + D1   | `takosumi-cloud-accounts`    | `takosumi-cloud/deploy/cloudflare/` |

## One-time operator prerequisites

1. Cloudflare account with the `takosumi.com` zone added (DNS hosted
   on Cloudflare).
2. `wrangler` installed and authenticated:
   ```sh
   npx wrangler login
   ```
   Or set the env vars `CLOUDFLARE_API_TOKEN` +
   `CLOUDFLARE_ACCOUNT_ID` for non-interactive deploys (CI).
   The token needs: Workers Scripts:Edit, Workers Routes:Edit,
   D1:Edit, Pages:Edit, Account Settings:Read.

DNS records for `takosumi.com`, `www.takosumi.com`, `docs.takosumi.com`
and `cloud.takosumi.com` are created automatically when you attach
each custom domain in the Cloudflare dashboard (Pages → Custom domains
or Workers → Custom domains).

---

## 1. `takosumi.com` — landing site (Cloudflare Pages)

**Source**: `takosumi/site/` (`index.html` + `build.sh` →
`./dist/`).

One-time setup:
```sh
cd takosumi
npx wrangler pages project create takosumi-site \
  --production-branch=main
# In dashboard:
#   Workers & Pages → takosumi-site → Custom domains
#   Add `takosumi.com`
#   (optional) Add `www.takosumi.com`
```

Deploy:
```sh
cd takosumi
deno task site:deploy
```

Smoke:
```sh
curl -I https://takosumi.com/        # expect 200
curl https://takosumi.com/ | head    # expect "Takosumi — self-hostable PaaS substrate"
```

---

## 2. `docs.takosumi.com` — VitePress docs (Cloudflare Pages)

**Source**: `takosumi/docs/` (VitePress site → `.vitepress/dist/`).

One-time setup:
```sh
cd takosumi
deno task docs:install                # installs vitepress + deps under docs/node_modules
npx wrangler pages project create takosumi-docs \
  --production-branch=main
# In dashboard:
#   Workers & Pages → takosumi-docs → Custom domains
#   Add `docs.takosumi.com`
```

Deploy:
```sh
cd takosumi
deno task docs:deploy
```

Smoke:
```sh
curl -I https://docs.takosumi.com/                           # 200
curl https://docs.takosumi.com/reference/architecture/        # links resolve
```

---

## 3. `cloud.takosumi.com` — Takosumi Accounts (Cloudflare Worker + D1)

**Source**: `takosumi-cloud/deploy/cloudflare/` (worker + wrangler.toml).

One-time setup:
```sh
cd takosumi-cloud
# Create the D1 database
npx wrangler d1 create takosumi-cloud-accounts
# Copy the returned UUID into deploy/cloudflare/wrangler.toml's
# `database_id` field (replacing the all-zeros placeholder).

# Push secrets (replace each value with the real secret on prompt)
npx wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK \
  --config deploy/cloudflare/wrangler.toml
npx wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET \
  --config deploy/cloudflare/wrangler.toml
npx wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET \
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
# {"ok":true,"provider":"cloudflare","service":"takosumi-cloud-accounts","persistence":"d1"}

curl https://cloud.takosumi.com/.well-known/openid-configuration | jq .issuer
# "https://cloud.takosumi.com"
```

---

## Updating downstream consumers

When `cloud.takosumi.com` is live, downstream products that consume
Takosumi Accounts need to point at it:

- `takos-private/apps/control/cloudflare/wrangler.toml` —
  `OIDC_ISSUER_URL = "https://cloud.takosumi.com"` (already set by
  this deploy plan in both production and staging blocks).
- Any other operator distribution that maintains its own OIDC client
  registration with Takosumi Accounts must update its issuer URL.

The OIDC client `takos-private-production` is registered with the
Worker via the `TAKOSUMI_ACCOUNTS_CLIENT_ID` /
`TAKOSUMI_ACCOUNTS_REDIRECT_URIS` vars in
`takosumi-cloud/deploy/cloudflare/wrangler.toml`. Update there if the
takos.jp callback URI changes.

## Rolling back

- **Pages** (`takosumi.com`, `docs.takosumi.com`): redeploy the
  previous git commit via `deno task site:deploy` /
  `deno task docs:deploy`. Cloudflare Pages also keeps deployment
  history in the dashboard for one-click rollback.
- **Worker** (`cloud.takosumi.com`): `wrangler rollback` or redeploy
  the previous commit. D1 state is preserved across rollbacks.

## CI

Push-to-deploy is intentionally not wired here — operators run the
deno tasks from a workstation. To add GitHub Actions later, wrap the
same tasks with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
exposed as repo secrets; the deploy commands themselves do not
change.
