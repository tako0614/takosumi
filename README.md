# Takosumi

Takosumi is an OpenTofu-native deploy control plane, UI, and audit ledger.

It installs plain OpenTofu module repositories into Spaces, records plan / apply / destroy runs, stores successful applies as `Deployment` records, and projects non-secret OpenTofu outputs as `DeploymentOutput` records.

Docs: <https://takosumi.com/docs/>

## Cloudflare Worker + D1 + R2 scaffold

The managed account-plane reference uses `deploy/accounts-cloudflare/` as the
Cloudflare Worker + D1 + R2 reference deployment profile. It runs the Accounts
Worker directly, stores account state in D1, and uses R2 only for
metadata-only Installation export artifacts. Cloudflare Container は不要 for
this account-plane path.

Bearer examples:

Auth boundary: list / inspect は account session bearer (`sess_...`) を使い、mutation 例は owner subject の account session bearer または `write` / `admin` PAT (`takpat_...`) を明示的に渡します。

```bash
bun packages/cli/src/main.ts installations list \
  --issuer https://accounts.takosumi.com \
  --token sess_owner

bun packages/cli/src/main.ts installations inspect ins_01ABCDEF \
  --issuer https://accounts.takosumi.com \
  --token sess_owner

bun packages/cli/src/main.ts installations status ins_01ABCDEF \
  --issuer https://accounts.takosumi.com \
  --token takpat_write \
  --status ready
```

These examples target `deploy/accounts-cloudflare/`, the Cloudflare Worker + D1 + R2 reference deployment profile. Cloudflare Container は不要 for this account-plane path.

## Quickstart

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

In another terminal:

```bash
export TAKOSUMI_REMOTE_URL=http://127.0.0.1:8788
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token

bun src/cli/main.ts plan /path/to/opentofu-module \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare

bun src/cli/main.ts install /path/to/opentofu-module \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare
```

Remote source syntax:

```text
git:https://github.com/example/module.git#main
prepared:https://example.com/module.tar.gz#sha256:<64 lowercase hex>
/path/to/local/module
```

## Public v1 surface

| Concept | Meaning |
| --- | --- |
| `Installation` | Space-scoped installed OpenTofu module record with source identity and current Deployment pointer. |
| `PlanRun` | One OpenTofu plan attempt with source digest, variables digest, policy decision, plan digest, logs, and audit events. |
| `ApplyRun` | One OpenTofu apply or destroy attempt with expected guard, state backend reference, lock evidence, status, logs, and audit events. |
| `Deployment` | Successful apply result with source identity, run links, status, and output snapshot. |
| `DeploymentOutput` | Non-secret output projection derived from `tofu output -json`. |
| `RunnerProfile` | Operator execution boundary for provider allowlists, credential references, state backend, runner substrate, resource limits, network policy, and Cloudflare Container execution. |

Takosumi does not replace OpenTofu. OpenTofu owns resource graph, provider schema, state operation, and apply semantics. Takosumi records the reviewable and auditable control-plane layer around those operations.

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        deploy-control DTOs and internal reference contracts
│   ├── service/         service implementation
│   ├── cli/             CLI implementation
│   ├── runtime-agent/   internal compatibility code
│   └── all/             package wrappers
├── packages/            managed account/dashboard surfaces
├── deploy/              operator deployment profiles
├── docs/                VitePress docs
├── website/             takosumi.com landing
├── fixtures/
└── scripts/
```

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run lint:json-ld
bun run docs:build
bun run website:build
bun run build:npm
```

## Package

Everything ships as the single npm package `@takosjp/takosumi`.

Key subpaths:

| Subpath | Purpose |
| --- | --- |
| `@takosjp/takosumi/contract` | public DTOs and deploy control contract |
| `@takosjp/takosumi/contract/deploy-control-api` | focused Deploy Control API contract |
| `@takosjp/takosumi/deploy-control` | deploy control client helpers |
| `@takosjp/takosumi/cli` | `takosumi` command |
| `@takosjp/takosumi/server` | service entry |

## Docs and website

`docs/` is the VitePress docs site served under `/docs/`. `website/` is the landing page. `bun run website:build` produces one Cloudflare Pages artifact containing the landing page, `/docs/`, and `/contexts/`.
