# Takosumi Cloudflare deploy runbook

This runbook covers the public Takosumi website/docs property and the managed account surface.

| Property | Resource type | Project / Worker name | Source |
| --- | --- | --- | --- |
| `takosumi.com` | Cloudflare Pages | `takosumi-website` | `website/` merged build |

The account plane (OIDC issuer / dashboard API / Installation ledger / billing) no
longer ships as a separate `accounts.takosumi.com` Worker. It runs **in-process**
inside the unified Takos worker at the origin root of `app.takosumi.com`. The
account-plane source lives at `deploy/accounts-cloudflare/src/{handler,routes}.ts`
(aliased into Takos as `@takosjp/takosumi-accounts-worker`); its `wrangler.toml`,
D1/R2 bindings, secrets, and deploy commands live with the unified Takos worker in
`takos/deploy/cloudflare/`, not in this repo. See
`takos/src/worker/server/routes/accounts/mount.ts`.

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

## Account plane (in-process)

The account plane (managed dashboard, OIDC, billing, deploy facade, account-facing
Installation projection) is part of the Takosumi distribution, not a separate public
core layer. It no longer deploys as a standalone `accounts.takosumi.com` Worker — it
runs in-process inside the unified Takos worker at the origin root of
`app.takosumi.com`. D1/R2 provisioning, secrets (`TAKOSUMI_ACCOUNTS_*`), the
`wrangler.toml`, and deploy commands live with the unified Takos worker in
`takos/deploy/cloudflare/`; the account-plane source is in
`deploy/accounts-cloudflare/src/{handler,routes}.ts` (D1 schema-migration gate
documented in `deploy/accounts-cloudflare/README.md`).

## GA evidence

Do not treat source build success as managed GA. GA evidence still needs live custom-domain health, OIDC, billing, dashboard, credential delivery, audit trail, and hosted Cloudflare Container runner proof for a real non-production provider apply.
