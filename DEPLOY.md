# Takosumi Cloudflare deploy runbook

This runbook covers the public Takosumi website/docs property and the managed account surface.

| Property | Resource type | Project / Worker name | Source |
| --- | --- | --- | --- |
| `takosumi.com` | Cloudflare Pages | `takosumi-website` | `website/` merged build |

The account plane (OIDC issuer / dashboard API / Installation ledger / billing) no
longer ships as a separate account-plane Worker. It runs **in-process** inside
the host worker: the operator Takosumi platform worker at `app.takosumi.com`, or
the self-hosted Takos product worker at the self-hoster's own origin. The
account-plane source lives at `deploy/accounts-cloudflare/src/{handler,routes}.ts`
(aliased as `@takosjp/takosumi-accounts-worker`); the host worker owns the
actual `wrangler.toml`, bindings, secrets, routes, and deploy command.
For the operator platform worker that host is `takosumi/deploy/platform/`; for
self-hosted Takos that host is the `takos/deploy/cloudflare/` template.

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
```

## Account plane (in-process)

The account plane (managed dashboard, OIDC, billing, deploy facade, account-facing
Installation projection) is part of the Takosumi distribution, not a separate public
core layer. It no longer deploys as a standalone account-plane Worker: it runs
in-process inside the host worker. D1/R2 provisioning, secrets
(`TAKOSUMI_ACCOUNTS_*`), the
`wrangler.toml`, and deploy commands live with the host worker
(`takosumi/deploy/platform/` for operator Takosumi, `takos/deploy/cloudflare/`
for self-hosted Takos); the account-plane source is in
`deploy/accounts-cloudflare/src/{handler,routes}.ts` (D1 schema-migration gate
documented in `deploy/accounts-cloudflare/README.md`).

## GA evidence

Do not treat source build success as managed GA. GA evidence still needs live custom-domain health, OIDC, billing, dashboard, credential delivery, audit trail, and hosted Cloudflare Container runner proof for a real non-production provider apply.
