# Takosumi Cloudflare deploy runbook

This runbook covers the public Takosumi website/docs property and the managed account surface.

| Property | Resource type | Project / Worker name | Source |
| --- | --- | --- | --- |
| `takosumi.com` | Cloudflare Pages | `takosumi-website` | `website/` merged build |
| `accounts.takosumi.com` | Cloudflare Worker + D1 + R2 | `takosumi-accounts` | `deploy/accounts-cloudflare/` |

## Prerequisites

1. Cloudflare account with the `takosumi.com` zone.
2. `wrangler` authenticated:

```bash
bunx wrangler login
```

For CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Pages edit, Workers edit, D1 edit, R2 edit, routes edit, and account read permissions.

## `takosumi.com`

`website/build.sh` builds:

```text
website/.output/public/
├── index.html
├── assets/
├── brand/
├── docs/
│   ├── index.html
│   ├── getting-started/
│   └── reference/
└── contexts/
    └── v1.jsonld
```

One-time setup:

```bash
cd takosumi
bunx wrangler pages project create takosumi-website \
  --production-branch=main
```

Attach `takosumi.com` and optionally `www.takosumi.com` in Cloudflare Pages custom domains.

Deploy:

```bash
cd takosumi
bun run website:deploy
```

Smoke:

```bash
curl -I https://takosumi.com/
curl -I https://takosumi.com/docs/
curl -I https://takosumi.com/docs/reference/model
curl https://takosumi.com/contexts/v1.jsonld | jq '.["@context"]["@vocab"]'
```

## `accounts.takosumi.com`

Cloudflare Worker + D1 + R2 is the current Accounts reference profile.

The account surface provides managed dashboard, OIDC, billing, deploy facade, and account-facing Installation projection. It is part of the Takosumi distribution, not a separate public core layer.

One-time setup:

```bash
cd takosumi
bunx wrangler d1 create takosumi-accounts
bunx wrangler r2 bucket create takosumi-accounts-exports
```

Put the D1 database id into the rendered Cloudflare config, then push secrets through Wrangler:

```bash
bunx wrangler secret put TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
bunx wrangler secret put TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET \
  --config deploy/accounts-cloudflare/wrangler.toml
```

Deploy:

```bash
cd takosumi
bun run deploy:accounts-cloudflare:dryrun
bun run deploy:accounts-cloudflare
```

Smoke:

```bash
curl https://accounts.takosumi.com/healthz
curl https://accounts.takosumi.com/.well-known/openid-configuration | jq .issuer
curl https://accounts.takosumi.com/healthz | jq -c '{"persistence":"d1+r2"}'
```

## GA evidence

Do not treat source build success as managed GA. GA evidence still needs live custom-domain health, OIDC, billing, dashboard, credential delivery, audit trail, and hosted Cloudflare Container runner proof for a real non-production provider apply.
