# Cloud Compatibility Import Path Note

Last updated: 2026-06-19

This document is intentionally not a general OSS Compatibility API framework
spec. It describes the Cloud-hosted import/deploy route family for
`compat.cloudflare.workers.v1`.

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
Cloudflare-shaped Workers import endpoint
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
an abstract fetch-handler key (`handlerKey`); the provider-compatible behavior
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

The current Cloud extension contract stops here: `compat.cloudflare.workers.v1`
and Takosumi AI Gateway. Other Cloud extension routes require a new
Operator/Cloud product spec and implementation. OSS compatibility profiles such
as S3, OCI, CloudEvents, Kubernetes CRD, or scoped Cloudflare Workers
compatibility remain capability-versioned Resource Shape entrypoints, not
complete provider API compatibility.

If Takosumi Cloud later wants another hosted extension endpoint, it requires a
new Operator/Cloud product spec and implementation. It must not be inferred from
the OSS route seam or from adding env vars to the platform worker.

The Cloudflare-shaped endpoint is an import/deploy path a Cloud Provider
Connection can put into the Cloudflare provider `base_url`:

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_token
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

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
