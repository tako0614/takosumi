# Operator

An operator runs Takosumi for Operators for their own users.

Takosumi for Operators is OSS. It does not include Cloudflare Compatibility
Gateway, managed edge, managed storage, official billing, or official resource
backends.

## Responsibilities

- configure control-plane auth and token boundaries
- define runner substrate, runner image, resource limits, and provider allowlist seed
- manage CredentialRecipe seeds, provider allowlists, and ProviderConnection policy
- manage sealed backing material and secret delivery for ProviderConnections
- manage state and lock backends
- manage local/docker/remote/operator runner pools
- operate a release activator materializer when enabled, and record app
  publication separately from the apply ledger
- keep provider credentials, control-plane tokens, and state backend credentials out of user workloads
- operate dashboard, API, audit, quota, and usage showback surfaces
- keep evidence for tenant isolation, workspace isolation, runner isolation, and network egress policy

## OSS Boundary

Takosumi for Operators runs existing OpenTofu/Terraform providers.

```text
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider
```

The OSS operator edition does not expose provider-compatible Gateway endpoints.

## Cloud Boundary

Takosumi Cloud is the closed official hosted deployment.

Only Cloud can include:

```text
Cloudflare Compatibility Gateway
Takosumi Managed Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV / Queue
Takosumi Cloud Container
official billing / quota / usage / support
official resource pools
```

These implementations, tests, secrets, and deployment config belong in the
closed Cloud repo.

## Production Readiness

OSS Operator GA readiness:

| Area               | Required evidence                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Website/docs       | docs build, custom domain/TLS if hosted publicly                                                                             |
| Runner             | non-production OpenTofu plan/apply/destroy proof                                                                             |
| Release activation | webhook/materializer proof, activation failure surfacing, rollback-independent ledger evidence if app publication is enabled |
| Accounts/auth      | dashboard, session/OIDC as configured, audit trail                                                                           |
| State              | state backend, lock evidence, backup/restore drill                                                                           |
| Secrets            | encrypted storage, rotation process, redaction proof                                                                         |
| Provider recipes   | CredentialRecipe seed, provider allowlist, ProviderConnection policy, and helper coverage                                    |
| Network            | provider allowlist and egress enforcement                                                                                    |
| Tenant isolation   | workspace/team separation and runner isolation                                                                               |
| Audit              | run, secret, state, and admin action evidence                                                                                |

Cloud GA adds managed resource, compatibility gateway, official billing, abuse,
support, usage metering, and deprovision proof requirements.
