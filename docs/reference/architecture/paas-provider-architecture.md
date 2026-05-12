# PaaS Provider Architecture

This document defines the architecture-layer surface that Takosumi must expose
when it is offered "as a PaaS". It records the deployment topology, the
multi-tenant boundary, the trust chain, the operator-facing surface set, and the
observable signals that allow an operator to run Takosumi as a tenant-bearing
service.

This doc is architecture-layer only. Wire-level shape lives in the reference
docs.

## PaaS deployment topology

One deployment topology is in v1 scope. The other rows are rejected concepts,
kept here only to prevent accidental scope expansion.

```text
single-operator       one operator runs one Takosumi kernel and hosts N Spaces
multi-operator        not adopted; separate operators run separate installations
platform federation   not adopted; kernels do not exchange catalog releases or shares
```

Takosumi v1 targets **single-operator + multi-Space tenant model**.
Multi-operator sharing and platform federation are not Takosumi platform
features and must not be assumed by architecture decisions. App-level
federation, if any, belongs to apps outside the platform layer.

## Multi-tenant boundary

`Space` is the v1 tenant boundary.

```text
Space = tenant boundary baseline
```

The operator chooses the tenant mapping policy:

```text
1 Space = 1 tenant      strict isolation per customer
N Space = 1 tenant      one tenant runs prod / staging / dev as separate Spaces
1 Space = N tenant      not supported in v1; tenants must not share a Space
```

A tenant identity larger than `Space` is operator-defined and lives outside
kernel state. The kernel only enforces Space-level invariants.

## Tenant isolation invariants

A Space-level invariant set is the v1 tenant guarantee. Every state surface
listed below is Space-scoped.

```text
namespace        namespace registry visibility is Space-scoped
secret           secret partition is Space-scoped
artifact         DataAsset visibility is Space-scoped
journal          OperationJournal entries belong to one Space
observation      ObservationSet, DriftIndex are Space-scoped
approval         Approval and PolicyDecision are Space-scoped
debt             RevokeDebt ownership is Space-scoped per the import side rule
activation       ActivationSnapshot and GroupHead are Space-local
```

Cross-space surfaces are denied by default. Cross-space export/share vocabulary
architecture may depend only on operator-owned namespace exports granted to the
Space.

## Billing readiness surfaces

Billing is external. The kernel does not implement billing logic. The
architecture must, however, expose measurement hooks so an external billing
system can attach without scraping internal storage.

Three measurement surfaces are required at architecture level:

```text
ActivationSnapshot history       per-Space activation events drive "what is running" usage
OperationJournal retention       per-Space apply / activate / destroy volume drives "operational" usage
ObservationSet cardinality       per-Space object / link / export count drives "footprint" usage
```

Architecture rules:

- Each surface is queryable per `spaceId`.
- Each surface emits monotonic event ids so an external collector can resume.
- The kernel does not retain billing-derived state. It exposes raw signals only.

## Supply chain trust

v1 supply chain trust is **TLS + digest pin + 1 signing domain (OIDC)**. The
kernel itself does not run a universal signing model; each boundary uses the
minimum mechanism that fits. See [Supply Chain Trust](../supply-chain-trust.md)
for the canonical chain of custody, and the boundary table below for
kernel-touching steps.

```text
CatalogRelease       operator-pinned sha256 digest (CATALOG_DIGEST), TLS fetch + digest verify
Connector            operator-installed, identified by operator config, kernel verifies registration via deploy token
Implementation       provider/runtime-agent contract, registration is operator-policy-gated (no kernel-side signing)
```

Trust rules:

- CatalogRelease trust is operator-pinned digest, not publisher signing. The
  kernel reads `CATALOG_DIGEST` from operator config and fails closed when the
  fetched catalog sha256 does not match.
- The kernel does not federate trust across operators in v1, and does not
  federate CatalogRelease trust either.
- Trust state is recorded in `ResolutionSnapshot`. A resolution against an
  untrusted artifact must surface a Risk and not silently succeed.
- The only signed runtime boundary the kernel issues internally is the
  Ed25519-signed gateway manifest to runtime-agents (kernel ↔ runtime-agent
  authentication); this is internal infra, not a public-facing publisher signing
  domain.

## Operator UX surfaces

Operator-facing surfaces are split across three channels. Every operator action
belongs to exactly one of them at architecture level.

```text
CLI                  takosumi-cli for human / scripted operator workflows
internal API         kernel internal HTTP endpoints for automation
operator console     UI surface that consumes the internal API
```

Surface inventory:

| Surface                     | CLI      | internal API | operator console |
| --------------------------- | -------- | ------------ | ---------------- |
| Space CRUD                  | yes      | yes          | yes              |
| Catalog release assignment  | yes      | yes          | yes              |
| Approval issue / revoke     | optional | yes          | yes              |
| RevokeDebt resolution       | yes      | yes          | yes              |
| Runtime-agent enrollment    | yes      | yes          | optional         |
| Implementation registration | yes      | yes          | optional         |
| Connector registration      | yes      | yes          | optional         |

The internal API is the canonical surface. The CLI and operator console are
clients of that API. Public deploy clients never address operator surfaces.

## SLA observable surfaces

A 99.x% availability promise is an operator commitment, not a kernel guarantee.
The kernel exposes the indicators that make such a promise auditable.

```text
apply latency                preview to OperationPlan accepted
activation latency           ActivationSnapshot prepared to GroupHead advanced
WAL replay time              kernel restart to journal-consistent steady state
drift detection latency      ObservationSet observedAt to DriftIndex emitted
RevokeDebt aging             RevokeDebt createdAt to status terminal transition
```

Each indicator is per-Space and time-bucketed. None of them are "alarm
thresholds" at architecture level. They are the observable surface. Thresholding
is operator policy.

## Disaster recovery boundary

Backup boundaries are split into recovery-critical and regenerable.

```text
recovery-critical (must be backed up)
  Space registry
  CatalogRelease assignments
  ResolutionSnapshot, DesiredSnapshot
  OperationJournal
  Approval and PolicyDecision
  RevokeDebt
  ActivationSnapshot history
  secret-store partition references (not values)

regenerable (must not be relied on as authority)
  ObservationSet (re-observed)
  DriftIndex (recomputed)
  ExportMaterial cache (re-projected)
  generated objects whose source is intact
```

Restore rule: a restore is consistent only if recovery-critical backups are
aligned to a common journal cut. Regenerable surfaces must be rebuilt from
observation after restore, not restored from backup as authority.

## kernel-side primitives for tenant operations

The surfaces above (multi-tenant boundary, billing readiness, supply chain
trust, operator UX, SLA observability, disaster recovery) describe what the
kernel exposes for tenant-bearing service. The detailed rationale for the
per-tenant primitives is split across three companion architecture docs, each
scoped to one concern:

- [Identity and Access Architecture](./identity-and-access-architecture.md) —
  why Actor, Organization, Membership, RBAC, API keys, and auth providers are
  kernel primitives; why the role enum is closed and provider binding is
  immutable.
- [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md) — why
  provisioning is a closed seven-stage idempotent sequence, why trial Spaces use
  a separate lifecycle, and how export and two-phase deletion preserve audit
  chain integrity.
- [PaaS Operations Architecture](./paas-operations-architecture.md) — why quota
  tiers are operator-named and kernel-enforced, why cost attribution is opaque
  metadata, why SLA detection and incidents are kernel-side, why support
  impersonation is a separate auth path, and why notifications are pull-only.

Together with the surfaces in this document, these three architecture docs
define the kernel-side scope for v1 PaaS operation. Customer signup UIs, payment
flows, status pages, branded notifications, ticket systems, SLA credit formulas,
and admin escalation workflows compose on top of these primitives but live
outside Takosumi (typically in `takos-private/` or another operator-owned
distribution).

## Cross-references

- [Operator Boundaries](./operator-boundaries.md)
- [Space Model](./space-model.md)
- [Identity and Access Architecture](./identity-and-access-architecture.md)
- [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md)
- [PaaS Operations Architecture](./paas-operations-architecture.md)
- [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
- [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [Operational Hardening Checklist](./operational-hardening-checklist.md)
- Reference: [CLI](../cli.md), [Kernel HTTP API](../kernel-http-api.md),
  [Lifecycle](../lifecycle.md)
