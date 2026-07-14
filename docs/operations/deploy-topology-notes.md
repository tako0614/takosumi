# Deploy Topology Notes

> このページでわかること: Takosumi operated environment の single-origin
> topology、交換可能な substrate adapter、再導入してはいけない
> split-control-plane / manifest-era 前提。

## Canonical Topology

operator は accounts / control plane / dashboard を **単一の Takosumi
origin** として公開します。これは論理的な product boundary であり、
Cloudflare Worker、Bun + Postgres、Kubernetes、VM など特定の substrate を
public contract に固定するものではありません。公開 repo の
`deploy/platform` は Cloudflare reference composition、`deploy/node-postgres`
は Bun + Postgres composition です。公式 Cloud の realized origin
`app.takosumi.com` は Takosumi Cloud の運用値であり、一般の Operator の
default hostname ではありません。

Takos product worker はユーザーが自分のインフラに self-host する別 build
target であり、Takosumi operator が暗黙に production hosting するものでは
ありません。

同じ origin が束ねる surface:

- accounts plane: account / membership / bare-origin OIDC issuer / dashboard contract
- control plane: `/api/v1` と `/hooks/*`
- dashboard-owned external prefill entrypoint: `/install?git=...`
- dashboard SPA / static assets
- queue consumer / scheduled handlers（有効な composition の場合）
- durable Run ownership / Capsule lease adapter
- `RunnerProfile.executorId` で明示選択された runner adapter / pool

`/internal/*` HTTP routes are reserved for executor callbacks, host-internal
control seams, and operator hardening gates. OSS Takosumi does not expose
provider-compatible Gateway bridges, provider `base_url` routes, or Gateway
run-key exchange endpoints. Runner callbacks are not public API and are not a
second control-plane product boundary.

## OpenTofu Capsule Boundary

Takosumi registers Git URLs as OpenTofu/Terraform Capsules under a Workspace
and Project. User repos stay plain Git repos containing OpenTofu
module-compatible configuration and do not need a Takosumi-specific manifest.
The durable control ledger is the source of truth for Workspace / Project /
Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding /
Secret / Run / StateVersion / Output / Runner / AuditEvent / UsageEvent.
Interface / InterfaceBinding declarations are service-side records that map
explicitly to ordinary Outputs; Output names never become runtime discovery
authority.

Legacy Space / Installation / StateSnapshot / OutputSnapshot / Deployment rows,
if present, are immutable migration state rather than the target public model.
Physical SQL table names and object-store paths are adapter-private layout.

## Logical Adapter Ports

Takosumi composition は次の logical capability を明示的に bind します。

- durable accounts / control-plane stores
- opaque source / artifact / state / backup stores
- Run dispatch queue または inline dispatch adapter
- Capsule lease / Run ownership adapter
- executor-id ごとの runner adapter
- dashboard static assets

Cloudflare reference composition では D1 / R2 / Queue / Durable Object /
Container bindings がこれらを実装します。Bun + Postgres composition では
Postgres と operator-provided artifact/runner adapters が実装します。実際の
binding 名、database id、bucket、endpoint、secret は operator config/vault
に置き、public repo に commit しません。私たちが運用する公式 Cloud の
realized config は `takosumi-private` が所有しますが、第三者 Operator に同じ
file layout を要求しません。

## Guardrails

Do not reintroduce:

- separate public accounts / control / dashboard product origins
- retired `apps/control` or manifest-era deploy engine language
- GitHub-specific core identifiers such as `githubInstallationId`
- source metadata files required in user repos
- public HTTP service boundaries for runner internals
- substrate names, binding names, or hosted URLs as scheduling authority
- old runtime names such as `control-web`, `control-dispatch`, `runtime-host`,
  `executor-host`, or `deployment-paas`

Local-substrate は同じ single-origin product boundary を
`app.takosumi.test` で再現します。そこで使う process/container 数は
production public contract ではありません。
