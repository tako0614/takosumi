# Operator

An operator runs Takosumi for Operator for their own users.

Takosumi OSS provides the Git-based OpenTofu control plane, Resource Shape API,
Compatibility API framework, and Adapter system. Takosumi for Operator adds
customer management, billing / metering / quota, an operator console, a managed
target catalog, and commercial operation. Takosumi Cloud is the official hosted
operation run by us.

## Responsibilities

- configure control-plane auth and token boundaries
- define runner substrate, runner image, resource limits, and provider allowlist seed
- manage CredentialRecipe seeds, provider allowlists, and ProviderConnection policy
- manage sealed backing material and secret delivery for ProviderConnections
- manage Resource Shape, TargetPool, Adapter, and compatibility profile availability
- manage state and lock backends
- manage local/docker/remote/operator runner pools
- operate customer, billing, metering, quota, and support workflows
- operate a release activator materializer when enabled, and record app
  publication separately from the apply ledger
- keep provider credentials, control-plane tokens, and state backend credentials out of user workloads
- operate dashboard, API, audit, quota, and usage showback surfaces
- keep evidence for tenant isolation, workspace isolation, runner isolation, and network egress policy

## OSS Boundary

Takosumi OSS has two portable boundaries.

```text
Git / OpenTofu stack:
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider

Resource Shape:
Resource
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

Operators can enable scoped and versioned compatibility profiles when they are
actually needed, such as `compat.s3.v1`, `compat.oci.v1`, and
`compat.cloudevents.v1`. If an existing OpenTofu provider or standard endpoint
is enough, use that instead of recreating it in Takosumi. Operators must report
the enabled surface through `/v1/capabilities` and must not claim full AWS or
full Cloudflare Workers provider compatibility.

## Operator / Cloud Boundary

Operator / Cloud own commercial operation and managed capacity.

```text
customer management
billing / metering / quota / plan
operator console
managed target catalog
support / abuse operation
commercial audit
operator-owned target pools
```

Takosumi Cloud is the official hosted deployment. It operates these as official
managed services:

```text
official resource pools
Takosumi Native Runtime
Takosumi Native Object Store
Takosumi Native Queue
Takosumi Native DB
Takosumi Edge Gateway
Takosumi AI Gateway
official billing / quota / usage / support / SLA
```

Official managed capacity implementations, tests, secrets, and deployment
config belong in the closed Cloud repo.

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
| Resource shapes    | TargetPool policy, adapter capability evidence, ResolutionLock behavior                                                      |
| Compatibility      | scoped/versioned capability list and negative proof for unsupported full-provider APIs                                       |
| Network            | provider allowlist and egress enforcement                                                                                    |
| Tenant isolation   | workspace/team separation and runner isolation                                                                               |
| Audit              | run, secret, state, and admin action evidence                                                                                |

Cloud GA adds official managed targets, hosted compatibility profiles, official
billing, abuse, support, usage metering, and deprovision proof requirements.
