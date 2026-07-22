# Takosumi Cloudflare deploy runbook

This runbook covers the public Takosumi website/docs property and the managed account surface.

| Property       | Resource type    | Project / Worker name | Source                  |
| -------------- | ---------------- | --------------------- | ----------------------- |
| `takosumi.com` | Cloudflare Pages | `takosumi-website`    | `website/` merged build |

The account plane (OIDC issuer / dashboard API / Capsule Run projection / billing) no
longer ships as a separate account-plane Worker. It runs **in-process** inside
the operator Takosumi platform worker, at `app.takosumi.com` for official Cloud
or at the explicit origin selected by another operator/self-hoster. The
account-plane source lives at `deploy/accounts-cloudflare/src/{handler,routes}.ts`
(aliased as `@takosjp/takosumi-accounts-worker`); the host worker owns the
actual `wrangler.toml`, bindings, secrets, routes, and deploy command.
That host is `takosumi/deploy/platform/`. The separate `takos/deploy/cloudflare/`
template deploys only the Takos product worker, which consumes this control plane
over OIDC and contract-shaped HTTP APIs.

## Prerequisites

1. Cloudflare account with the `takosumi.com` zone.
2. `wrangler` authenticated:

```bash
bunx wrangler login
```

For CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs
Pages edit, Workers edit, account read, and read/create permissions for every
Cloudflare resource the Capsule creates. The Takos/yurucommu staging smokes
currently require D1, Workers KV Storage, R2, and Queues permissions. Run
`smoke:platform-control-plane` with `--cloudflare-resource-preflight
account-resources` before resource-creating applies so missing account-resource
permissions fail before OpenTofu can partially create resources.

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

This deploys the merged landing/docs artifact to the Pages production branch
`main`. A deploy from a detached checkout without `--branch main` creates only a
preview deployment and does not update `takosumi.com`.

Smoke:

```bash
curl -I https://takosumi.com/
curl -I https://takosumi.com/docs/
curl -I https://takosumi.com/docs/reference/model
curl -I https://app.takosumi.com/docs/
curl -I https://app.takosumi.com/docs/endpoints
```

## Account plane (in-process)

The account plane (managed dashboard, OIDC, billing, deploy facade, account-facing
Capsule / Run / Output projection) is part of the Takosumi distribution, not a separate public
core layer. It no longer deploys as a standalone account-plane Worker: it runs
in-process inside the host worker. D1/R2 provisioning, secrets
(`TAKOSUMI_ACCOUNTS_*`), the
`wrangler.toml`, and deploy commands live with the operator platform worker in
`takosumi/deploy/platform/`; the account-plane source is in
`deploy/accounts-cloudflare/src/{handler,routes}.ts` (D1 schema-migration gate
documented in `deploy/accounts-cloudflare/README.md`).

## GA evidence

Do not treat source build success as managed GA. GA evidence still needs live custom-domain health, OIDC, billing, dashboard, credential delivery, audit trail, and hosted Cloudflare Container runner proof for a real non-production provider apply.
