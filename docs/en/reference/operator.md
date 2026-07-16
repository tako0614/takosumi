# Operator

An operator runs Takosumi for Operator for their own users.

Takosumi OSS provides the Git-based OpenTofu control plane, an optional
zero-form-capable Service Form host (current Resource Shape compatibility API),
Compatibility API framework, and Adapter system. The portable project owns
Service Forms, FormRefs, data-only Form Packages, and typed-client conformance;
the Takosumi operator owns package pins, trusted implementations, Target /
Policy / credentials, and generic FormActivation. Takosumi for Operator adds
customer management, billing / metering / quota, DB-backed operator
configuration, CLI/API/runbook operations, a managed target catalog, and
commercial operation. Takosumi Cloud is the official hosted operation run by us.

## Responsibilities

- configure control-plane auth and token boundaries
- define runner substrate, runner image, resource limits, and provider allowlist seed
- manage CredentialRecipe seeds, provider allowlists, and ProviderConnection policy
- manage sealed backing material and secret delivery for ProviderConnections
- manage Form Registry, implementation, FormActivation, TargetPool, Adapter, and compatibility profile availability
- tune scheduled Resource observation cadence, batch, and concurrency to runner capacity
- manage state and lock backends
- in production/staging, do not infer encryption at rest from the database URL
  format; set storage-adapter evidence, or a confirmed
  `TAKOSUMI_DATABASE_ENCRYPTION_AT_REST=verified` plus non-secret
  `TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE`
- manage local/docker/remote/operator runner pools
- when using Workers for Platforms, treat it as the tenant/user Worker ingress
  boundary, separate from the OpenTofu runner execution boundary
- operate customer, billing, metering, quota, and support workflows
- operate a release activator materializer when enabled, and record app
  publication separately from the apply ledger
- keep provider credentials, control-plane tokens, and state backend credentials out of user workloads
- operate user-facing dashboard, API, audit, quota, and usage showback surfaces
- handle operator-only operations through DB-backed config, CLI, API, runbooks,
  and audit evidence
- keep evidence for tenant isolation, workspace isolation, runner isolation, and network egress policy

## OSS Boundary

Takosumi OSS has two portable boundaries.

```text
Git / OpenTofu stack:
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider

Service Form host (current Resource Shape API):
exact FormRef + Resource
  -> installed definition / implementation / FormActivation
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
DB-backed operator configuration
CLI / API / runbook operations
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

## Scheduled Service Form-backed Resource observation

The platform worker runs read-only scheduled observation by default when the
host enables at least one current Resource Shape compatibility kind. Only `Ready` Resources at their
current generation are eligible. Observation runs against the pinned Target and
implementation as a non-applyable `drift_check`; it never applies or refreshes.
A durable lease deduplicates candidates across all Spaces and isolates one
Resource failure from the rest of the tick.

| Variable                                         | Default | Accepted range | Meaning                                            |
| ------------------------------------------------ | ------- | -------------- | -------------------------------------------------- |
| `TAKOSUMI_RESOURCE_OBSERVATION_ENABLED`          | auto    | `0` / `1`      | Unset follows whether any shape kind is enabled    |
| `TAKOSUMI_RESOURCE_OBSERVATION_BATCH`            | `8`     | `1`–`32`       | Maximum Resources claimed in one tick              |
| `TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY`      | `4`     | `1`–`8`        | Maximum simultaneous backend observations          |
| `TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS` | `3600`  | `300`–`604800` | Minimum interval between attempts for one Resource |
| `TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS`    | `900`   | `600`–`7200`   | Abandoned-claim reclamation delay                  |

Invalid or out-of-range values fall back to safe defaults. Keep the batch small
enough for the runner pool. Verify each observation outcome through the
`outcome` label on `takosumi_resource_observation_count`.

## Production Readiness

OSS Operator GA readiness:

| Area               | Required evidence                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Website/docs       | docs build, custom domain/TLS if hosted publicly                                                                                 |
| Runner             | non-production OpenTofu plan/apply/destroy proof                                                                                 |
| Release activation | webhook/materializer proof, terminal-success gate, retained state/output and non-ready Run/Capsule/Interface evidence on failure |
| Accounts/auth      | dashboard, session/OIDC as configured, audit trail                                                                               |
| State              | state backend, lock evidence, backup/restore drill                                                                               |
| Secrets            | encrypted storage, rotation process, redaction proof                                                                             |
| Provider recipes   | CredentialRecipe seed, provider allowlist, ProviderConnection policy, and helper coverage                                        |
| Resource shapes    | TargetPool policy, adapter capability evidence, ResolutionLock behavior                                                          |
| Compatibility      | scoped/versioned capability list and negative proof for unsupported full-provider APIs                                           |
| Network            | provider allowlist and egress enforcement                                                                                        |
| Tenant isolation   | workspace/team separation and runner isolation                                                                                   |
| Audit              | run, secret, state, and admin action evidence                                                                                    |

Cloud GA adds official managed targets, hosted compatibility profiles, official
billing, abuse, support, usage metering, and deprovision proof requirements.
