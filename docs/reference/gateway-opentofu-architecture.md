# Cloud-Only Compatibility Gateway Note

Last updated: 2026-06-19

This document is intentionally not an OSS implementation spec.

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
