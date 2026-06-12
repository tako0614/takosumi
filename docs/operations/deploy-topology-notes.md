# Deploy Topology Notes

> このページでわかること: Takosumi operated environment の single-worker
> topology と、再導入してはいけない split-worker / manifest-era 前提。

## Canonical Topology

operator がデプロイするのは **単一 Cloudflare Worker**
(Takosumi platform worker, `app.takosumi.com`) のみです。Takos product
worker はユーザーが自分のインフラに self-host するもので、operator は
production hosting しません。

platform worker が in-process で束ねる surface:

- accounts plane: account / billing / bare-origin OIDC issuer / dashboard contract
- control plane: `/api/v1` と `/install`
- dashboard SPA: `ASSETS`
- queue consumer / scheduled handlers
- `CoordinationObject`
- `OpenTofuRunnerObject` + Runner Container

`/internal/*` HTTP routes are reserved for opentofu-runner / executor container
callbacks. They are not public API and are not a split service boundary.

## OpenTofu Capsule Boundary

Takosumi installs Git URLs as OpenTofu Capsules under a Space. User repos stay
plain Git repos containing OpenTofu module-compatible configuration. The repo
does not need a Takosumi-specific manifest. The D1 control ledger is the source of truth for
Space / Source / Connection / Provider Template / Provider Env Set /
provider env set policy / OpenTofu Capsule / Compatibility Report / Installation / InstallConfig / DeploymentProfile /
ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup / Deployment /
OutputSnapshot / Backup / UsageEvent / Billing / Activity. R2 paths are storage layout only.

## Bindings

The platform worker owns these binding classes:

- Hosted D1 ledgers for accounts and control-plane records
- R2 source / artifact / state / backup buckets
- `RUN_QUEUE`
- `COORDINATION`
- `RUNNER`
- dashboard `ASSETS`

Real binding names and ids live in `takosumi-private/platform/wrangler.toml`.
Secret values live in the operator vault and are never committed.

## Guardrails

Do not reintroduce:

- separate public accounts / control / dashboard workers
- retired `apps/control` or manifest-era deploy engine language
- GitHub-specific core identifiers such as `githubInstallationId`
- source metadata files required in user repos
- public HTTP service boundaries for runner internals
- old workload names such as `control-web`, `control-dispatch`,
  `runtime-host`, `executor-host`, or `deployment-paas`

Local-substrate mirrors the same single platform worker topology under
`app.takosumi.test`.
