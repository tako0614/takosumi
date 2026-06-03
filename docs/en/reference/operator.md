# Operator

An operator runs the Takosumi distribution and owns RunnerProfiles, storage, auth, dashboard, billing / OIDC surfaces, and hosted runners.

## Responsibilities

- configure Deploy Control API auth
- define RunnerProfiles
- manage credential references and secret delivery
- manage state backend and lock backend
- manage OpenTofu runner image / container / queue
- when using Cloudflare Workers for Platforms, manage the dispatch namespace, outbound Worker, and tenant Worker binding policy
- keep provider credentials, Deploy Control tokens, and state backend credentials out of tenant Workers
- expose dashboard views for PlanRun, ApplyRun, Deployment, DeploymentOutput, and Workload Service projections
- collect production evidence before managed public access

## Workload Services

Workload Services are service projections that the Accounts / operator distribution exposes to deployed workloads. They
are not Takosumi core public concepts. The core public surface remains Installation, PlanRun, ApplyRun, Deployment,
DeploymentOutput, and RunnerProfile.

The v1 reference distribution exposes:

| Service | Material kind | Secret | Meaning |
| --- | --- | --- | --- |
| `identity.primary.oidc` | `identity.oidc@v1` | no | operator OIDC issuer and per-installation public client |
| `billing.primary.default` | `billing.port@v1` | yes | billing portal and usage report endpoint |
| `deployment.outputs.http` | `deployment.outputs.http@v1` | no | public HTTP URLs projected from OpenTofu outputs |
| `events.webhook.default` | `events.webhook@v1` | yes | workload event ingest into the Accounts event ledger |
| `takosumi.control.space` | `takosumi.control@v1` | yes | same-space workload control service |

API:

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/v1/workload-services` | account session / PAT read |
| GET | `/v1/installations/{id}/services` | owner account session / PAT read |
| POST | `/v1/installations/{id}/services/{serviceId}/rotate-token` | owner account session / PAT write |
| POST | `/v1/installations/{id}/events/ingest` | current `events.webhook.default` workload token |

`rotate-token` returns the raw token once. Normal GET responses, App detail, DeploymentOutput, and public event
serialization only expose `secret_ref` and expiry. Rotation validity is recorded through the InstallationEvent ledger's
current token hash, so old tokens are invalid after the next rotation on both D1 and Postgres stores.

The `takosumi.control.space` token is for same-space workload control. It is limited to same-space installation list /
detail / events / outputs / deploy / rollback / materialize / export / usage report operations. It cannot manage
RunnerProfiles, provider credentials, state backends, billing owners, account tokens, or the OIDC issuer.

## Production Readiness

| Area | Required evidence |
| --- | --- |
| Hosted runner | Cloudflare Container runner plan/apply evidence |
| Tenant runtime | Workers for Platforms dispatch namespace and outbound Worker isolation proof |
| Provider live proof | non-production `plan/apply/destroy` evidence for each enabled Cloudflare / AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean profile |
| Secret boundary | leak tests for runner diagnostics, failure audit messages, OpenTofu outputs, and tenant Worker bindings |

## Public site

`takosumi/website/` is the landing page. `takosumi/docs/` is the docs site. `bun run website:build` combines the landing page, `/docs/`, and `/contexts/` into one Cloudflare Pages artifact.
