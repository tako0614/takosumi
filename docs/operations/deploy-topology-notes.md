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
- control plane: `/api/v1` と `/hooks/*`
- dashboard-owned external prefill entrypoint: `/install?git=...`
- dashboard SPA: `ASSETS`
- queue consumer / scheduled handlers
- `CoordinationObject`
- `OpenTofuRunnerObject` + Runner Container

`/internal/*` HTTP routes are reserved for opentofu-runner / executor container callbacks, host-internal control seams,
and operator hardening gates. OSS Takosumi does not expose provider-compatible Gateway bridges, provider `base_url`
routes, or Gateway run-key exchange endpoints. Runner callbacks are not public API and are not a split service
boundary.

## OpenTofu Capsule Boundary

Takosumi registers Git URLs as OpenTofu/Terraform Capsules under a Workspace and Project. User repos stay
plain Git repos containing OpenTofu module-compatible configuration. The repo
does not need a Takosumi-specific manifest. The D1 control ledger is the source of truth for
Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
StateVersion / Output / Runner / AuditEvent / UsageEvent / Billing. Legacy Space / Installation / StateSnapshot /
OutputSnapshot / Deployment rows, if present, are migration state rather than the target public model. R2 paths are
storage layout only.

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
- old runtime names such as `control-web`, `control-dispatch`,
  `runtime-host`, `executor-host`, or `deployment-paas`

Local-substrate mirrors the same single platform worker topology under
`app.takosumi.test`.
