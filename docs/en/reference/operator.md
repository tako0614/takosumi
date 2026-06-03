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
- expose dashboard views for PlanRun, ApplyRun, Deployment, and DeploymentOutput
- collect production evidence before managed public access

## Production Readiness

| Area | Required evidence |
| --- | --- |
| Hosted runner | Cloudflare Container runner plan/apply evidence |
| Tenant runtime | Workers for Platforms dispatch namespace and outbound Worker isolation proof |
| Provider live proof | non-production `plan/apply/destroy` evidence for each enabled Cloudflare / AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean profile |
| Secret boundary | leak tests for runner diagnostics, failure audit messages, OpenTofu outputs, and tenant Worker bindings |

## Public site

`takosumi/website/` is the landing page. `takosumi/docs/` is the docs site. `bun run website:build` combines the landing page, `/docs/`, and `/contexts/` into one Cloudflare Pages artifact.
