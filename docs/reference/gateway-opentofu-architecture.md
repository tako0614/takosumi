# Cloud-Only Compatibility Gateway Note

Last updated: 2026-06-19

This document is intentionally not an OSS implementation spec for the gateway
backend.

Takosumi OSS does not provide a provider-compatible Gateway, Cloudflare
compatibility API, managed edge backend, managed storage backend, or run-key
minting system. OSS Takosumi runs existing OpenTofu/Terraform providers against
the user's real provider accounts through ProviderConnections and
CredentialRecipes.

The only current product spec for this boundary is:

```text
OSS:
  run existing providers as-is

Cloud:
  add compatibility APIs and managed resources
```

See [Takosumi Final Plan](../final-plan.md) and
[Core Spec](../core-spec.md).

## Cloud Scope

The following belong to closed Takosumi Cloud:

```text
Takosumi Cloud Workers
Cloudflare Compatibility Gateway
Takosumi AI Gateway
Cloudflare provider base_url endpoint
OpenAI-compatible AI endpoint
short-lived Cloud run keys
virtual account/resource IDs
closed managed resource backend integration
managed edge/storage/database/container resources
official billing/quota/usage/support
```

If Takosumi Cloud implements these features, their production architecture,
tests, deployment config, secrets, and provider-compatible endpoint behavior
must live in the closed Cloud implementation, not in the OSS repo.

The OSS platform worker may reserve public route seams through the Cloud
extension route registry. A registry entry contains only the route base path and
an abstract fetch-handler key (`bindingName`); the provider-compatible behavior
itself stays in the closed Cloud implementation.

For official staging/production `app.takosumi.com`, the closed
`takosumi-cloud/platform/worker.ts` wrapper is the Worker entry. It wraps
`takosumi/deploy/platform/worker.ts` and mounts the Cloud extension fetch
handlers in-process:

```text
/compat/cloudflare/client/v4/*
  -> cloud_extensions registry
  -> TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT handler key
  -> in-process Cloudflare compatibility handler

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
platform worker must not activate a gateway by itself.

The `/readyz` baseline does not require Cloud extension handlers. GA
evidence for AI Gateway or Cloudflare compatibility must prove the corresponding
route is mounted and reaches the closed Cloud handler inside the platform
wrapper.

The current compatibility API contract stops here: Cloudflare Compatibility
Gateway and Takosumi AI Gateway. AWS, GCP, S3-compatible storage, Hetzner,
Vultr, DigitalOcean, OpenStack, and other providers should be handled through
normal OpenTofu/Terraform providers plus ProviderConnection / CredentialRecipe /
ProviderBinding env-file injection. Takosumi OSS and Takosumi for Operators
should not grow provider-compatible endpoints for those providers.

If Takosumi Cloud later wants another compatibility endpoint, it requires a new
Cloud-only product spec and closed implementation. It must not be inferred from
the OSS route seam or from adding env vars to the platform worker.

The Cloudflare compatibility endpoint is an import/deploy path a Cloud-only
Provider Connection can put into the Cloudflare provider `base_url`:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_token
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

The first Cloud-only compatibility slice is limited to the Workers family from
the final plan: Workers scripts/routes, Workers KV namespace bindings, R2
buckets, D1 databases, Worker vars/secrets/bindings, and virtual account/resource
IDs. DNS, WAF, Rulesets, Zero Trust, IAM, Billing, Registrar, Load Balancer,
Email Routing, and Turnstile stay out of the initial compatibility contract.

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
