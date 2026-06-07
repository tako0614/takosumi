# Operator

An operator runs the Takosumi platform worker and owns storage, auth, dashboard, billing / OIDC surfaces, hosted
runners, and internal execution profiles. The core public surface is Space, Source, Connection, OpenTofu Capsule,
Installation, Dependency, Run, RunGroup, Deployment, OutputSnapshot, Billing, and Activity.

## Responsibilities

- configure control-plane auth
- define internal execution profiles (substrate / runner image / resource limits / provider allowlist seed); see [Internal execution profiles](./runner-profiles.md)
- manage Connections / operator default connections and secret delivery
- manage state backend and lock backend
- manage OpenTofu runner image / container / queue
- when using Cloudflare Workers for Platforms, manage the dispatch namespace, outbound Worker, and tenant Worker binding policy
- keep provider credentials, control-plane tokens, and state backend credentials out of tenant Workers
- expose dashboard views for Installation, Run, Deployment, OutputSnapshot, Activity, and Billing projections
- collect production evidence before managed public access

## Workload integrations

Hosted/operator distributions can expose integration tokens or service projections to deployed workloads, such as OIDC
client material, billing portal links, webhook ingest endpoints, or same-Space control callbacks. These are **operator
integration details**, not Takosumi core public concepts. They must be derived from Installation, Deployment,
OutputSnapshot, Billing, Activity, and Connection policy records rather than becoming new core resources.

Integration token rules:

- raw token values are returned once at creation/rotation time only
- normal reads expose only a secret reference, expiry, and non-secret metadata
- tokens are scoped to one Space and one intended capability
- tokens cannot manage execution profiles, provider credentials, state backends, billing ownership, account tokens, or
  OIDC issuer configuration
- token creation, rotation, and use are recorded as Activity or internal redacted audit evidence without storing token
  values

## Production Readiness

| Area                | Required evidence                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Website             | `takosumi.com` custom domain, TLS, `/docs/` build                                                                                         |
| Hosted runner       | Cloudflare Container runner plan/apply evidence                                                                                           |
| Account surface     | dashboard, OIDC, billing, credential delivery, audit trail                                                                                |
| State               | remote state backend and lock evidence                                                                                                    |
| Policy              | provider allowlist / credential delivery evidence / network policy / allowed host pattern enforcement                                     |
| Tenant runtime      | Workers for Platforms dispatch namespace and outbound Worker isolation proof                                                              |
| Provider live proof | non-production `plan/apply/destroy` evidence for each enabled Cloudflare / AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean execution boundary |
| Secret boundary     | leak tests for runner diagnostics, failure audit messages, OpenTofu outputs, and tenant Worker bindings                                   |

## Local service

```bash
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token>
export TAKOSUMI_DEV_MODE=1
bun src/cli/main.ts server --port 8788
```

In production, do not use `TAKOSUMI_DEV_MODE`; inject persistent storage, managed auth, secret store, and runner
substrate through operator config.

## Public site

`takosumi/website/` is the landing page. `takosumi/docs/` is the docs site. `bun run website:build` combines the landing page, `/docs/`, and `/contexts/` into one Cloudflare Pages artifact.
