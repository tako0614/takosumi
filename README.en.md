# Takosumi

日本語: [README.md](README.md)

Takosumi is an OSS control plane that safely deploys and manages Git-hosted OpenTofu/Terraform modules
through a plan → review → apply workflow. It runs existing OpenTofu/Terraform providers as-is — no
proprietary manifest or DSL is needed.

What you get:

- Register modules from any Git URL as apps or infrastructure (Capsule)
- Store cloud credentials securely and inject them only while a Run executes (ProviderConnection)
- Review planned changes before applying them, then apply with approval (plan / apply Run)
- Record state after every apply and track who changed what, when (StateVersion / AuditEvent)
- Capture module outputs and optionally wire them into another Capsule's inputs (Output)

Software docs: <https://takosumi.com/docs/>
Hosted Cloud docs: <https://app.takosumi.com/docs/>

## Local control-plane quickstart

Run the local control-plane service directly when you want to exercise the `/api/v1` contract from curl or tests.

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

The standard product flow is to install via the dashboard using a Git URL, creating a Capsule from a Git Source.
Dashboard install / plan / apply go through the [`/api`](docs/en/reference/deploy-control-api.md) control plane
against a registered Git Source. App source, build outputs, container images, and release artifacts are modeled by
the Git-hosted OpenTofu module and its ordinary variables, not by a Takosumi-owned upload/build path. The CLI is
documented in [docs/en/reference/cli.md](docs/en/reference/cli.md). The retired `takosumi deploy` /
`takosumi plan` local-upload helpers fail closed and do not create public Capsules.

## How it works

Takosumi's account-plane and control-plane handlers are composed **in-process** through `tsconfig` aliases into an
operator-run Takosumi platform worker. An operator or self-hoster serves that platform worker at an explicit origin;
our official hosted deployment uses `app.takosumi.com`. There is no npm-published service package.

The self-hosted Takos distribution worker is a separate Takos product worker. It references Takosumi contract source
and uses the self-hoster/operator Takosumi control plane as an external OIDC issuer and resource server. It does not
embed Accounts, deploy-control, the Dashboard, or the runner. `takosumi.com` is the landing/software-docs site.

### In-process entry points

| Handler        | File                                                                  | Mount                                                  |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Account plane  | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`) | platform worker origin root; issuer is the bare origin |
| Deploy control | `worker/src/handler.ts`                                               | platform worker `/api` and `/hooks/*`                  |

`/install?git=...&ref=...&path=...` is a dashboard SPA entrypoint, not a deploy-control handler. The SPA preserves the
query, forwards to `/new`, and only pre-fills the Git form; compatibility check and explicit confirmation still happen
inside `/new`.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the same `createAccountsHandler` for the
local-substrate cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate
behind the one handler, not an alternate distribution.

## Public surface

The product flow is deliberately small: choose a **Workspace** and **Project**, register a Git **Source**, create a
**Capsule**, bind provider aliases through **ProviderConnections**, **CredentialRecipes**, and **ProviderBindings**,
review a **Run**, then inspect **StateVersions**, **Outputs**, and **AuditEvents**. See the public
[Model reference](docs/en/reference/model.md) and [glossary](docs/en/reference/glossary.md). Implementer-facing final
direction lives in [docs/internal/final-plan.md](docs/internal/final-plan.md) (not a published product contract).

| Concept              | Meaning                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Workspace`          | User/team owner boundary for projects, provider connections, secrets, state isolation, and audit.                               |
| `Project`            | One product, service, application, or infrastructure group.                                                                     |
| `Capsule`            | One OpenTofu/Terraform module execution unit, usually sourced from Git URL + ref + path.                                        |
| `Source`             | Git URL / branch / ref / commit / module path. Upload/prepared-source archives are internal/operator compatibility only.        |
| `ProviderConnection` | Provider credential configuration stored in Takosumi and resolved into temporary env/file material only while a Run executes.   |
| `CredentialRecipe`   | Provider-specific env/file/pre-run action definition for running an existing OpenTofu/Terraform provider as-is.                 |
| `ProviderBinding`    | Provider address or alias to ProviderConnection mapping.                                                                        |
| `Secret`             | Encrypted backing material; secret values are write-only to APIs and redacted from logs.                                        |
| `Run`                | One init / validate / plan / apply / destroy / refresh / output execution with source snapshot, provider bindings, and logs.    |
| `StateVersion`       | Persisted Capsule state generation.                                                                                             |
| `Output`             | Captured `tofu output -json`, optionally wired into another Capsule's inputs.                                                   |
| `Runner`             | Local/docker/remote/operator/cloud execution boundary for checkout, OpenTofu execution, state sync, output extraction, cleanup. |
| `AuditEvent`         | Actor/action/target/result evidence.                                                                                            |
| `Operator`           | The person or organization running Takosumi for their own users.                                                                |

Takosumi does not replace OpenTofu or Terraform providers. Existing providers run as-is; Takosumi records the reviewable
and auditable control-plane layer around those operations.

Takosumi OSS also owns a noncommercial `Offering` catalog, open subject resolvers, and exact `OfferingSelection` over
`type + ref + version + digest`. A Service Form is one possible subject type; an Offering does not imply that Takosumi
Cloud sells it. Cloud can attach a closed `CommercialOfferingBinding` only to that exact selection, binding manager,
capacity, SKU, PriceCatalog, and payment evidence without creating a second availability or selection engine.

## Editions

| Edition                   | What it is                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Takosumi OSS**          | This repository: Git-based OpenTofu/Terraform control plane, optional zero-form-capable Service Form host (current Resource Shape compatibility API), generic Offering selection, Compatibility API framework, Adapter system, ProviderConnections, runner pool, state/output/audit, and disabled/showback billing that never blocks apply. |
| **Takosumi for Operator** | OSS/commercial operator edition for hosting Takosumi for users or customers: multi-tenant customer management, quota/metering/plans, DB-backed operator configuration, CLI/API/runbook operations, managed target catalog, support tooling, and commercial audit.                                                                           |
| **Takosumi Cloud**        | The official hosted Takosumi for Operator at `app.takosumi.com`, with a closed CommercialOfferingBinding for each exact Offering selection, official managed targets, Takosumi-owned native resource internals, AI Gateway, Stripe-enforced billing, quota, usage, support, abuse controls, and SLA.                                        |

The dependency direction is **one-way Cloud -> OSS**: the hosted Cloud operation consumes OSS contracts and composition
points. OSS ships and runs with nothing from the hosted Cloud operation present.

## Repository layout

The current layout is `contract/`, `core/`, `lib/`, `accounts/`, `providers/`, `worker/`, `runner/`,
`opentofu-modules/`, `dashboard/`, `website/`, and `deploy/`. See the [AGENTS.md](AGENTS.md) "Workspace" section for the
annotated tree (single source of truth to avoid drift).

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run docs:build
bun run app-docs:build
bun run website:build
```

## Docs and website

`docs/` is the VitePress software docs site served from `takosumi.com/docs/`.
`app-docs/` is the hosted Cloud docs site embedded into `dashboard/dist/docs/`
for `app.takosumi.com/docs/`. `website/` is the landing page. `bun run
website:build` produces one Cloudflare Pages artifact containing the landing
page and software `/docs/`.
