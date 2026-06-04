# Takosumi

Takosumi is the source module that provides the OpenTofu-native deploy-control plane, the accounts plane, and the audit
ledger for the single Takos worker.

It installs plain OpenTofu module repositories into Spaces, records plan / apply / destroy runs, stores successful applies as `Deployment` records, and projects non-secret OpenTofu outputs as `DeploymentOutput` records.

Takosumi is consumed **in-process** by the takos worker through `tsconfig` aliases. There is no standalone Takosumi
worker, no `accounts.takosumi.com` / `deploy-control.takosumi.com`, and no npm publish. One operator runs one
Cloudflare worker serving everything under `app.takosumi.com`; `takosumi.com` is the landing/docs site only.

Docs: <https://takosumi.com/docs/>

## In-process entry points

| Handler | File | Mount |
| --- | --- | --- |
| Account plane | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`) | takos worker origin root; issuer is the bare origin |
| Deploy control | `deploy/cloudflare/src/handler.ts` | takos worker in-process fetch seam; no public routes |

`deploy/accounts-cloudflare/` stores account state in D1 and uses R2 only for metadata-only Installation export
artifacts. Cloudflare Container is not used by the account-plane path; it is used by the deploy-control runner for
OpenTofu `plan` / `apply`.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the same `createAccountsHandler` for the
local-substrate cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate
behind the one handler, not an alternate distribution.

## Public v1 surface

| Concept | Meaning |
| --- | --- |
| `Installation` | Space-scoped installed OpenTofu module record with source identity and current Deployment pointer. |
| `PlanRun` | One OpenTofu plan attempt with source digest, variables digest, policy decision, plan digest, logs, and audit events. |
| `ApplyRun` | One OpenTofu apply or destroy attempt with expected guard, state backend reference, lock evidence, status, logs, and audit events. |
| `Deployment` | Successful apply result with source identity, run links, status, and output snapshot. |
| `DeploymentOutput` | Non-secret output projection derived from `tofu output -json`. |
| `RunnerProfile` | Execution boundary for provider allowlists, credential references, state backend, runner substrate, resource limits, network policy, and Cloudflare Container execution. |

Takosumi does not replace OpenTofu. OpenTofu owns resource graph, provider schema, state operation, and apply semantics. Takosumi records the reviewable and auditable control-plane layer around those operations.

## CLI quickstart

The CLI talks to the running deploy-control surface.

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

## Workspace

```text
takosumi/
├── package.json
├── src/
│   ├── contract/        deploy-control DTOs and internal reference contracts
│   ├── service/         service implementation consumed in-process by the takos worker
│   ├── cli/             CLI implementation
│   ├── runtime-agent/   internal compatibility code
│   └── all/             package wrappers
├── deploy/              in-process handlers + runner/container + substrates
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
```

## Docs and website

`docs/` is the VitePress docs site served under `/docs/`. `website/` is the landing page. `bun run website:build` produces one Cloudflare Pages artifact containing the landing page, `/docs/`, and `/contexts/`.
