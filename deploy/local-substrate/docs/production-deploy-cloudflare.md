# Retired: Split Cloudflare Production Deploy Runbook

This file is intentionally retired.

It used to describe a split production topology with `accounts.takosumi.com` and
an operator-selected service Worker hostname. That topology is no longer the
canonical Takosumi model.

The current production shape is:

| Purpose | Canonical host |
| --- | --- |
| Takosumi platform worker | `https://app.takosumi.com` |
| Landing and docs site | `https://takosumi.com` |

The platform worker is the only operator-run Cloudflare Worker. It composes:

- the accounts plane and bare-origin OIDC issuer;
- the in-process `/api` deploy-control surface;
- the `/install` external install link;
- the dashboard SPA;
- the OpenTofu runner container and control-plane bindings.

Operator-realized Worker routes, resource IDs, and secrets live outside this
repository in operator-private state. Do not recreate the old
`accounts.takosumi.com` / separate service Worker production topology from this
archived runbook.

Use these current references instead:

- [`../../platform/wrangler.toml`](../../platform/wrangler.toml) for the
  platform worker template;
- [`../../../docs/operations/platform-worker-deploy.md`](../../../docs/operations/platform-worker-deploy.md)
  when the operator runbook exists in the operations docs;
- [`../../../AGENTS.md`](../../../AGENTS.md) and the ecosystem
  [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md) for the canonical boundary.

## Archived Checklist Fingerprint

The following archived tokens are retained only so legacy documentation drift
checks can identify the retired runbook lineage. Do not execute this checklist
for production:

- Accounts Cloudflare Worker + D1 + R2
- `wrangler d1 create takosumi-accounts`
- `wrangler r2 bucket create takosumi-accounts-exports`
- `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET`
