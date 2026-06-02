# Takosumi

Takosumi is a manifestless source-to-deployment substrate. It installs a `Source` into a Space, records an
`Installation`, and stores each apply result as a `Deployment` with the reviewed install plan and operator-resolved
PlatformService bindings.

Docs: <https://takosumi.com/docs/>

## Quickstart

Run a local service and install a local source root. The source root can be any repo; Takosumi reads generic metadata such
as Git identity and `package.json`.

```bash
npm install -g @takosjp/takosumi
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788 &

mkdir hello-takosumi && cd hello-takosumi
printf '{"name":"hello-takosumi","version":"0.1.0"}\n' > package.json

takosumi install dry-run \
  --remote http://127.0.0.1:8788 \
  --token "$TAKOSUMI_INSTALLER_TOKEN" \
  --space space_personal \
  --source .
```

Managed or remote operators use an operator-issued token and URL:

```bash
export TAKOSUMI_INSTALLER_TOKEN=<operator-issued-installer-token>
export TAKOSUMI_REMOTE_URL=https://service.example.com

takosumi install --source git:https://github.com/example/notes#v1.2.3 \
  --space space_personal
```

## Takosumi Concepts

| Concept | Meaning |
| --- | --- |
| `Source` | `git`, `prepared`, or `local` input plus resolved identity such as commit or source digest. |
| `Installation` | Space-scoped installed source record with a current Deployment pointer. |
| `Deployment` | One apply result with source summary, plan snapshot, binding snapshot, outputs, and status. |
| `PlatformService` | Operator-catalog service capability selected during install or deploy. |

Dry-run returns an `InstallPlan` snapshot and `planSnapshotDigest`. The plan is review data, not a persisted public
entity. Apply can send `expected.planSnapshotDigest` to guard that the reviewed source and binding resolution are still
the ones being applied.

## Operator Boundary

Takosumi does not run Terraform/OpenTofu, own provider credentials, or manage IaC state locks. Operator
distributions create and operate infrastructure, then publish databases, buckets, OIDC issuers, queues, runtimes, and
other services into PlatformService inventory. Takosumi records which services were selected for an Installation.

Backend adapters, runtime-agent implementation code, inventory importers, and OpenTofu state handling are operator-owned
implementation details. Takosumi consumes the resulting PlatformService inventory and Deployment outputs; it is not a
Terraform/OpenTofu provider replacement and does not publish a separate runtime handler package.

## Takosumi Accounts

This repository also contains the reference account/operator distribution surface under `packages/accounts-*` and
`deploy/`. Takosumi Accounts owns account authorization, dashboard routes, OIDC/billing projection, and the
AppInstallation ledger projection around the Takosumi Installer API. Customer-facing launch scope is tracked in
[`docs/accounts/managed-offering-customer-boundary.md`](docs/accounts/managed-offering-customer-boundary.md).

The Cloudflare Worker + D1 + R2 scaffold lives in `deploy/accounts-cloudflare/`. It is the Cloudflare Worker + D1 + R2
reference deployment profile for Accounts; Cloudflare Container は不要 for the account-plane critical path.

AppInstallation read examples use an account session bearer, while mutation examples use an owner session bearer or a
scoped PAT:

```bash
takosumi accounts installations list \
  --remote https://accounts.takosumi.com \
  --token sess_owner \
  --space space_personal

takosumi accounts installations inspect inst_example \
  --remote https://accounts.takosumi.com \
  --token sess_owner

takosumi accounts installations status inst_example \
  --remote https://accounts.takosumi.com \
  --token takpat_write \
  --status ready
```

For Cloudflare operators, `deploy/accounts-cloudflare/` is the Cloudflare Worker + D1 + R2 reference deployment profile;
Cloudflare Container は不要 for this Accounts path.

Public managed access stays closed until the private readiness bundle, public summary, separate operator approval, and
live audit all match. The open-gate dry-run is digest-bound:

```bash
takosumi accounts serve --dry-run \
  --managed-offering-access open \
  --managed-offering-readiness-file .managed-readiness/staging/rehearsal-YYYY-MM-DD.json \
  --managed-offering-readiness-digest <validate-json evidenceDigest> \
  --managed-offering-evidence-ref vault://managed-readiness/staging/rehearsal.json \
  --managed-offering-approval-ref approval://managed-readiness/staging/operator-approval.json \
  --managed-offering-public-summary "P0 evidence and one staged launch rehearsal passed."
```

The closed gate covers passkey register / authenticate route, core OAuth authorize/token, personal access token create,
status ready/reopen patch, ready or installing status changes, dashboard deployment operations, upstream OAuth
authorize/callback, installation dry-run/apply, launch-token creation/consume, and installation import.

## CLI

```bash
takosumi install --space <id> --source <source>
takosumi install dry-run --space <id> --source <source>
takosumi deploy <installation-id> [--source <source>]
takosumi deploy dry-run <installation-id> [--source <source>]
takosumi rollback <installation-id> <deployment-id>
takosumi server [--port 8788]
takosumi version
```

Source syntax:

```text
git:<url>#<ref>
prepared:<url>#<sha256:hex>
<local-path>
```

## npm Package

Everything in this repository ships as one npm package,
[`@takosjp/takosumi`](https://www.npmjs.com/package/@takosjp/takosumi), reached through subpath exports:

| Subpath | Purpose |
| --- | --- |
| `@takosjp/takosumi` | umbrella entry for Takosumi exports |
| `@takosjp/takosumi/contract` | public Installer API DTOs and reference SDK types |
| `@takosjp/takosumi` | reference service and Installer API server |
| `@takosjp/takosumi/installer` | source fetchers and Installer API client |
| `@takosjp/takosumi/cli` | `takosumi` command |
| `@takosjp/takosumi/runtime-agent` | lifecycle execution host for operator adapters |
| `@takosjp/takosumi/server` | Installer API server entry |

## Workspace Layout

```text
takosumi/
├── package.json
├── src/
│   ├── contract/
│   ├── service/
│   ├── installer/
│   ├── cli/
│   ├── runtime-agent/
│   └── all/
├── docs/
├── website/
├── deploy/
├── fixtures/
└── scripts/
```

## Development

```bash
bun install --frozen-lockfile
bun run check
bun test ./src/
bun run test:scripts
bun run lint:json-ld
bun run build:npm
```

The source is Bun-first. Keep host-specific compatibility behind the existing runtime-adapter and fetcher boundaries.

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks the workspace with Bun, builds the npm
package through `bun run build:npm`, and publishes `@takosjp/takosumi` to npm. Container images and backend-specific
implementation bundles are materialized and released by each operator distribution (via OpenTofu), not by this public
package.

## Docs Site

`takosumi/docs/` is the VitePress site (`base: "/docs/"`). `takosumi/website/` is the Solid Start landing. The Pages
output merges landing, docs, contexts, and operator-facing reference assets under the same `takosumi.com` project.
