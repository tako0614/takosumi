# Takosumi website and platform Worker deploy runbook

This runbook covers the public Takosumi website/docs property and the operator-owned
Takosumi platform Worker. Takosumi Cloud is a retired historical identity; this
document is not a hosted-service, Takosumi Hosted retail, or Takoserver managed-supply
runbook.

| Property / surface | Resource type | Project / Worker name | Source |
| --- | --- | --- | --- |
| `takosumi.com` | Cloudflare Pages | `takosumi-website` | `website/` merged build |
| operator-selected origin | Cloudflare Worker | operator-owned platform Worker | `deploy/platform/` composed build |

The account plane (OIDC issuer / dashboard API / Capsule Run projection / billing) no
longer ships as a separate account-plane Worker. It runs **in-process** inside
the operator Takosumi platform Worker at the explicit origin selected by that
operator/self-hoster. The
account-plane source lives at `deploy/accounts-cloudflare/src/{handler,routes}.ts`
(aliased as `@takosjp/takosumi-accounts-worker`); the host worker owns the
actual `wrangler.toml`, bindings, secrets, routes, and deploy command.
That host is `deploy/platform/`. The separate `takos/deploy/cloudflare/` template
deploys only the Takos product worker, which consumes this control plane over OIDC
and contract-shaped HTTP APIs.

The platform Worker is a control-plane component. It does not deploy tenant
customer module code, managed customer ModuleWorkers/WfP, or a Takoserver Host.
Customer Git modules execute as Run-scoped OpenTofu work in the runner after the
platform is deployed. Takoserver owns managed supply, capacity, provider
installation/credentials, Offering, and Host execution.

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
curl -I https://takosumi.com/docs/reference/api

# Use the exact operator-owned platform origin, not a retired Cloud URL.
TAKOSUMI_PUBLIC_ORIGIN=https://takosumi.example.com
curl -I "$TAKOSUMI_PUBLIC_ORIGIN/healthz"
curl -I "$TAKOSUMI_PUBLIC_ORIGIN/.well-known/takosumi"
```

## Account plane (in-process)

The account plane (dashboard, OIDC, billing hooks, deploy facade, account-facing
Capsule / Run / Output projection) is part of the Takosumi distribution, not a
separate public core layer. It runs in-process inside the operator platform
Worker. D1/R2 provisioning, secrets
(`TAKOSUMI_ACCOUNTS_*`), the
`wrangler.toml`, and deploy commands live with the operator platform worker in
`deploy/platform/`; the account-plane source is in
`deploy/accounts-cloudflare/src/{handler,routes}.ts` (D1 schema-migration gate
documented in `deploy/accounts-cloudflare/README.md`).

This section does not authorize deployment of tenant customer code or Takoserver
managed ModuleWorker/WfP/Host surfaces. Those have separate owner-controlled
deployment contracts.

## GA evidence

Do not treat source build success as hosted-service availability. Evidence for an
operator deployment still needs live origin health, OIDC, dashboard, credential
delivery, audit trail, and a real non-production provider apply using that
operator's account. Takosumi Hosted retail evidence and Takoserver managed-supply
capacity/provider evidence belong to those products, not this OSS deploy runbook.
