# Provider Compatibility Profile Import Path Note

Last updated: 2026-06-19

This document is intentionally not a general OSS Compatibility API framework
spec. It describes how the `compat.cloudflare.workers.v1` provider
compatibility profile is mounted by Takosumi Cloud and consumed by OpenTofu
providers through a normal `base_url`.

Takosumi OSS may provide the Compatibility API framework, scoped compatibility
profiles such as `compat.s3.v1`, and adapter contracts. It does not provide the
official hosted `compat.cloudflare.workers.v1` backend, managed edge backend,
official managed storage backend, or Cloud run-key minting system. The
OpenTofu Stack flow still runs existing OpenTofu/Terraform providers against
the user's real provider accounts through ProviderConnections and
CredentialRecipes.

The current boundary is:

```text
OSS:
  Compatibility API framework and portable capability profiles

Operator/Cloud:
  official managed capacity and hosted Cloud extension backends
```

See [Takosumi Final Plan](./final-plan.md) and [Core Spec](./core-spec.md).

## Cloud Scope

The following belong to closed Takosumi Cloud:

```text
Takosumi Cloud EdgeWorker runtime
Cloudflare Workers provider compatibility profile
Takosumi AI Gateway
OpenAI-compatible AI endpoint
short-lived Cloud run keys
virtual account/resource IDs
closed managed resource backend integration
managed edge/storage/database/container resources
official billing/quota/usage/support
```

If Takosumi Cloud implements these features, their production architecture,
tests, deployment config, secrets, and provider-compatible profile behavior
must live in the closed Cloud implementation, not in the OSS repo.

The OSS platform worker may reserve public route seams through the Cloud
extension route registry. A registry entry contains the route base path, an
abstract fetch-handler key (`handlerKey`), and, when the route accepts managed
provider run tokens, an opaque `managedProviderProfile`. The matching
service-side ProviderConnection explicitly declares that same profile. The
provider-compatible behavior itself stays in the closed Cloud implementation.

For official staging/production `app.takosumi.com`, the closed
`takosumi-cloud/platform/worker.ts` wrapper is the Worker entry. It wraps
`takosumi/deploy/platform/worker.ts` and mounts the Cloud extension fetch
handlers in-process:

```text
/compat/cloudflare/client/v4/*
  -> cloud_extensions registry
  -> TAKOSUMI_CLOUD_PROVIDER_COMPAT_CLOUDFLARE_WORKERS handler key
  -> in-process Cloudflare Workers provider compatibility profile handler

/gateway/ai/v1/*
  -> cloud_extensions registry
  -> TAKOSUMI_CLOUD_AI_GATEWAY handler key
  -> in-process AI Gateway handler

/cloud/usage/*
  -> cloud_extensions registry
  -> TAKOSUMI_CLOUD_USAGE handler key
  -> in-process Cloud usage handler

*.app.takos.jp/*
  -> Takosumi Cloud wrapper host dispatch
  -> in-process Cloud Edge Runtime handler
```

If no handler is mounted, the route returns `404 { "error": "not found" }`.
Adding `TAKOSUMI_AI_GATEWAY_PROFILES` or provider-looking env vars to the OSS
platform worker must not activate a provider compatibility profile by itself.

The `/readyz` baseline does not require Cloud extension handlers. GA
evidence for AI Gateway or the Cloudflare Workers provider compatibility
profile must prove the corresponding route is mounted and reaches the closed
Cloud handler inside the platform wrapper.

The current Cloud extension contract stops here: `compat.cloudflare.workers.v1`
and Takosumi AI Gateway. Other Cloud extension routes require a new
Operator/Cloud product spec and implementation. OSS compatibility profiles such
as S3, OCI, CloudEvents, Kubernetes CRD, or scoped Cloudflare Workers
compatibility remain capability-versioned compatibility entrypoints for
Takosumi-managed capabilities, not complete provider API compatibility and not
subordinate routes into `takosumi/takosumi`.

If Takosumi Cloud later wants another hosted extension endpoint, it requires a
new Operator/Cloud product spec and implementation. It must not be inferred from
the OSS route seam or from adding env vars to the platform worker.

The Cloudflare Workers provider compatibility endpoint is an import/deploy path
a Cloud Provider Connection can put into the Cloudflare provider `base_url`:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_token
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

That `base_url` remains a natural Cloudflare provider argument; it is not
credential or managed-capacity authority. Public usability and token issuance
come only from the explicit matching `managedProviderProfile`. Deploying this
contract therefore requires updating the operator-owned ProviderConnection and
its extension descriptor together; either side missing or disagreeing fails
closed.

The first Cloud-only compatibility slice is limited to importing
Workers-oriented resources into Takosumi Cloud resources: `EdgeWorker`, routes,
KV namespace bindings, object buckets, app databases, Worker vars/secrets, and
virtual account/resource IDs. DNS, WAF, Rulesets, Zero Trust, IAM, Billing,
Registrar, Load Balancer, Email Routing, and Turnstile stay out of the initial
compatibility contract.

## OSS Scope

OSS Takosumi should instead keep these paths strong:

```text
ProviderConnection
CredentialRecipe
ProviderBinding
run-scoped env/file injection
state/version/lock/backup
outputs-to-inputs wiring
runner protocol
audit log
policy and approval
```

The OSS compatibility story is not "imitate cloud APIs." It is "same manifest,
different connection."
