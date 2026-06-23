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
Cloudflare Compatibility Gateway
provider-compatible base_url endpoints
short-lived Cloud run keys
virtual account/resource IDs
Workers for Platforms backend integration
managed edge/storage/database/container resources
official billing/quota/usage/support
```

If Takosumi Cloud implements these features, their production architecture,
tests, deployment config, secrets, and provider-compatible endpoint behavior
must live in the closed Cloud implementation, not in the OSS repo.

The OSS platform worker may reserve public route seams and delegate them through
the Cloud extension route registry. A registry entry contains only the route
base path and the Cloud-only service binding name; the provider-compatible
behavior itself stays in the closed Cloud implementation.

```text
/compat/cloudflare/client/v4/*
  -> TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT service binding
  -> closed Takosumi Cloud compatibility worker

/gateway/ai/v1/*
  -> TAKOSUMI_CLOUD_AI_GATEWAY service binding
  -> closed Takosumi Cloud AI Gateway worker
```

If the service binding is absent, the route returns `404 { "error": "not
found" }`. Adding `TAKOSUMI_AI_GATEWAY_PROFILES` or provider-looking env vars to
the OSS platform worker must not activate a gateway by itself.

Future provider-compatible entry points such as AWS, GCP, or S3-compatible
managed resources follow the same rule:

```text
1. implement the provider-compatible behavior in closed Takosumi Cloud
2. bind that Cloud worker/service to the platform worker
3. add one registry row with basePath + bindingName + provider id
4. keep OSS ProviderConnection / CredentialRecipe / ProviderBinding unchanged
```

For example, an AWS compatibility experiment would be a Cloud-only extension
such as `/compat/aws/v1/* -> TAKOSUMI_CLOUD_AWS_COMPAT`; it is not active unless
Takosumi Cloud ships that closed binding. The OSS control plane still runs
`hashicorp/aws` against the user's real AWS account through normal
ProviderConnections.

The Cloudflare compatibility endpoint is the path a Cloud-only Provider
Connection can put into the Cloudflare provider `base_url`:

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
