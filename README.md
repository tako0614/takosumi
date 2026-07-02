# Takosumi

Takosumi is one OSS OpenTofu-native control plane. It provides deploy-control, accounts, dashboard, runner boundary, and
audit ledger code that can be composed in two contexts:

- the operator-run Takosumi platform worker at `app.takosumi.com`;
- the self-hosted Takos distribution worker, where the Takos product surface composes Takosumi accounts, deploy-control,
  dashboard, and runner boundaries in-process at the self-hoster's own origin.

It registers plain OpenTofu/Terraform modules from Git URLs as Capsules under a Workspace/Project, binds providers or
aliases to ProviderConnections through ProviderBindings, records plan/apply/destroy Runs, persists StateVersions, and
projects OpenTofu outputs as Outputs.

Takosumi handlers are consumed **in-process** through `tsconfig` aliases by the host worker. That is a composition
mechanism, not two different products. There is no retired split account/deploy-control host topology, and no
npm-published service package. One hosted operator runs one Cloudflare worker serving the platform under
`app.takosumi.com`; `takosumi.com` is the landing/docs site only.

Docs: <https://takosumi.com/docs/>

## In-process entry points

| Handler        | File                                                                  | Mount                                                                               |
| -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Account plane  | `deploy/accounts-cloudflare/src/handler.ts` (`createAccountsHandler`) | platform worker or takos worker origin root; issuer is the bare origin              |
| Deploy control | `worker/src/handler.ts`                                               | `/api` on the platform worker; typed in-process operations seam in the takos worker |

`/install?git=...&ref=...&path=...` is a dashboard SPA entrypoint, not a deploy-control handler. The SPA preserves the
query, forwards to `/new`, and only pre-fills the Git form; compatibility check and explicit confirmation still happen
inside `/new`.

`deploy/accounts-cloudflare/` stores account-plane state in D1. Capsule backup/export artifacts belong to the
deploy-control backup/export flow and its R2 buckets, not to the account-plane ownership boundary. Cloudflare Container
is not used by the account-plane path; it is used by the deploy-control runner for OpenTofu `plan` / `apply`.

`deploy/node-postgres/` is the Bun + Postgres substrate that backs the same `createAccountsHandler` for the
local-substrate cloud profile (the `deploy/local-substrate/` cloud wrapper imports its server). It is a substrate
behind the one handler, not an alternate distribution.

## Public surface

The product flow is deliberately small: choose a **Workspace** and **Project**, register a Git **Source**, create a
**Capsule**, bind provider aliases through **ProviderConnections**, **CredentialRecipes**, and **ProviderBindings**,
review a **Run**, then inspect **StateVersions**, **Outputs**, and **AuditEvents**. See [AGENTS.md](AGENTS.md) "Public
Surface" and [docs/internal/final-plan.md](docs/internal/final-plan.md) for the current model.

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

Legacy Space / Installation / Deployment / OutputSnapshot / `takos_provided` /
pre-v1 provider endpoint wording may still appear in migration notes or
internal implementation names, but it is not the current public surface.

Takosumi does not replace OpenTofu or Terraform providers. Existing providers run as-is; Takosumi records the reviewable
and auditable control-plane layer around those operations. OSS Takosumi owns the Resource Shape API, Compatibility API
framework, and Adapter system. Official managed target pools, Takosumi-owned native resource internals, enforced
billing, support/SLA, and official resource backends belong to Takosumi for Operator / Takosumi Cloud.

## Editions

| Edition                                   | What it is                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Takosumi OSS**                          | This repository: Git-based OpenTofu/Terraform control plane, Resource Shape API, Compatibility API framework, Adapter system, ProviderConnections, runner pool, state/output/audit, and disabled/showback billing that never blocks apply.          |
| **Takosumi for Operator**                 | OSS/commercial operator edition for hosting Takosumi for users or customers: multi-tenant customer management, quota/metering/plans, operator console, managed target catalog, support tooling, and commercial audit.                               |
| **Takosumi Cloud**                        | The official hosted Takosumi for Operator at `app.takosumi.com`, with official managed targets, Takosumi-owned native resource internals, AI Gateway, Stripe-enforced billing, quota, usage, support, abuse controls, and SLA.                    |

The dependency direction is **one-way Cloud -> OSS**: the hosted Cloud operation consumes OSS contracts and composition
points. OSS ships and runs with nothing from the hosted Cloud operation present.

## Local control-plane quickstart

Run the local control-plane service directly when you want to exercise the `/api/v1` contract from curl or tests.
The CLI is documented separately in [docs/reference/cli.md](docs/reference/cli.md): the standard product flow is
dashboard Git URL install and Capsule creation from a Git Source. The retired
`takosumi deploy` / `takosumi plan` local-upload helpers fail closed and do not
create public Capsules.

```bash
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

Dashboard install / plan / apply go through the [`/api`](docs/reference/deploy-control-api.md) control plane against a
registered Git Source. App source, build outputs, container images, and release
artifacts are modeled by the Git-hosted OpenTofu module and its ordinary
variables, not by a Takosumi-owned upload/build path.

## Workspace

The current layout is `contract/`, `core/`, `lib/`, `accounts/`, `providers/`, `worker/`, `runner/`,
`opentofu-modules/`, `dashboard/`, `website/`, and `deploy/`. See the [AGENTS.md](AGENTS.md) "Workspace" section for the
annotated tree (single source of truth to avoid drift).

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run docs:build
bun run website:build
```

## Docs and website

`docs/` is the VitePress docs site served under `/docs/`. `website/` is the landing page. `bun run website:build` produces one Cloudflare Pages artifact containing the landing page and `/docs/`.
