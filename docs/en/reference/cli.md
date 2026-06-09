# CLI

The Takosumi CLI's headline command is **`takosumi deploy`**. Like `wrangler deploy`, it deploys a local OpenTofu
Capsule directory straight into your Space. Reading the operator's local working directory is the one thing the
dashboard fundamentally cannot do, and it is the CLI's reason to exist — no push to a git Source required (git
integration is an optional add-on).

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi deploy ./my-capsule --space @me --name my-app --var region=apac
takosumi plan   ./my-capsule --space @me --name my-app   # upload + plan only
takosumi status <run-id>
takosumi logs   <run-id>
```

The CLI never runs the heavy work (Capsule Gate / plan / apply). It tars the local Capsule with zstd, uploads it to the
control plane, and asks `/api/deploy` to resolve/create the Installation and plan the upload snapshot. Execution happens
inside the runner container with per-phase vault-minted credentials; the CLI handles no credential material.

## How deploy works

1. `takosumi deploy <dir>` tars the local Capsule with `tar --zstd`.
2. `POST /api/spaces/:id/uploads` stores the bytes in R2_SOURCE and records an **upload-origin SourceSnapshot**.
3. `POST /api/deploy` resolves/creates the `@space/name` Installation (synthesizing a default InstallConfig when new)
   and starts a plan Run pinned to that upload snapshot.
4. The CLI polls the Run and prints its status.

A git Source is an optional "connect a repo for auto-builds" feature, not a precondition for an Installation.

## Operator

The thin operator helpers for running `app.takosumi.com` share the same bin.

```bash
takosumi run connections
takosumi run secrets
```

Internal/development helpers for accounts, installations, launch readiness, and migrations remain in the repo, but they
are hidden from normal runbooks and root help. The public API / dashboard / Run ledger is canonical; the CLI does not
interpret OpenTofu configuration.

## Japanese Output

```bash
TAKOSUMI_LANG=ja takosumi run connections --help
TAKOSUMI_LANG=ja takosumi run secrets --help
```

Set `TAKOSUMI_LANG=ja`, or run under a Japanese locale such as `LANG=ja_JP.UTF-8`, to show Japanese help.

## Registration

On operator machines, place a wrapper or symlink on PATH.

```bash
ln -sf /root/dev/takos/takosumi/packages/cli/src/main.ts /usr/local/bin/takosumi
chmod +x /root/dev/takos/takosumi/packages/cli/src/main.ts
```

For local checks from a fresh clone, call the same code path directly.

```bash
cd takosumi
bun run cli -- run connections --help
```

## Connections

Operator-only CLI for registering and checking Takosumi-provided provider defaults. Credential values are read only from
files and are never printed. Space/user-owned provider env sets are dashboard/API flows, not CLI flows.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<operator-deploy-control-bearer>

takosumi run connections set-cloudflare-token \
  --api-token-file /operator/vault/cloudflare-api-token \
  --default cloudflare

takosumi run connections list
takosumi run connections defaults list
takosumi run connections defaults set cloudflare conn_...
takosumi run connections test conn_...
takosumi run connections revoke conn_...
```

## Secrets

Check and apply Takosumi platform Worker secrets from the operator vault. Takosumi-provided provider defaults use
`connections`; user-owned credentials use dashboard/API flows.

`apply` creates missing generatable secrets before pushing. It does not overwrite existing signing keys, the
secret-store passphrase, pairwise secrets, or provider credentials. Only safe-rotation secrets can be regenerated
individually.

```bash
takosumi run secrets status
takosumi run secrets apply
takosumi run secrets apply --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

In the normal operator checkout, where `takosumi-private/` is next to `takos/` or `takosumi/`, the CLI auto-detects
`takosumi-private/platform/wrangler.toml` and `takosumi-private/.secrets/production`. Set these only when using another
location.

```bash
export TAKOSUMI_WRANGLER_CONFIG=/operator/takosumi-private/platform/wrangler.toml
export TAKOSUMI_SECRETS=/operator/takosumi-private/.secrets/production
```

`status` / `apply` never print secret values. Remote-only secrets are not deleted automatically; operators should
inspect `status` and delete intentionally with `wrangler secret delete` when needed.

## Environment

| Variable                        | Purpose                                |
| ------------------------------- | -------------------------------------- |
| `TAKOSUMI_DEPLOY_CONTROL_URL`   | deploy-control endpoint                |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | operator bearer                        |
| `TAKOSUMI_WRANGLER_CONFIG`      | realized wrangler config               |
| `TAKOSUMI_SECRETS`              | local operator vault directory         |
| `TAKOSUMI_LANG`                 | Japanese help when set to `ja`         |
