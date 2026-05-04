# PaaS Provider Design

This document defines the design-layer surface that Takosumi must expose when it is offered "as a PaaS". It records the deployment topology, the multi-tenant boundary, the trust chain, the operator-facing surface set, and the observable signals that allow an operator to run Takosumi as a tenant-bearing service.

This doc is design-layer only. Wire-level shape lives in the reference docs.

## PaaS deployment topology

Three deployment topologies are recognized. Only the first is in v1 scope.

```text
single-operator       one operator runs one Takosumi kernel and hosts N Spaces
multi-operator        multiple operators share infrastructure but keep separate kernels
federation            kernels exchange catalog releases or shares across operator trust domains
```

Takosumi v1 targets **single-operator + multi-Space tenant model**. Multi-operator and federation are not supported by v1 contracts; they are intentionally left for future revisions and must not be assumed by v1 design decisions.

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

A tenant identity larger than `Space` is operator-defined and lives outside kernel state. The kernel only enforces Space-level invariants.

## Tenant isolation invariants

A Space-level invariant set is the v1 tenant guarantee. Every state surface listed below is Space-scoped.

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

Cross-space surfaces are denied by default. Crossing a Space boundary requires an explicit `SpaceExportShare` or operator-approved namespace import. See [Space Model](./space-model.md).

## Billing readiness surfaces

Billing is external. The kernel does not implement billing logic. The kernel design must, however, expose measurement hooks so an external billing system can attach without scraping internal storage.

Three measurement surfaces are required at design level:

```text
ActivationSnapshot history       per-Space activation events drive "what is running" usage
OperationJournal retention       per-Space apply / activate / destroy volume drives "operational" usage
ObservationSet cardinality       per-Space object / link / export count drives "footprint" usage
```

Design rules:

- Each surface is queryable per `spaceId`.
- Each surface emits monotonic event ids so an external collector can resume.
- The kernel does not retain billing-derived state. It exposes raw signals only.

## Supply chain trust

Three trust steps form the v1 supply chain. Each step has a distinct signer and a distinct verifier.

```text
CatalogRelease       signed by catalog publisher, verified by operator at adoption
Connector            signed by operator (operator-installed), verified by kernel at registration
Implementation       signed by implementation publisher, verified by operator policy at registration
```

Trust rules:

- The kernel does not federate trust across operators in v1.
- An external participant publishing into a Space goes through Connector trust, not CatalogRelease trust.
- Trust state is recorded in `ResolutionSnapshot`. A resolution against an untrusted artifact must surface a Risk and not silently succeed.

## Operator UX surfaces

Operator-facing surfaces are split across three channels. Every operator action belongs to exactly one of them at design level.

```text
CLI                  takosumi-cli for human / scripted operator workflows
internal API         kernel internal HTTP endpoints for automation
operator console     UI surface that consumes the internal API
```

Surface inventory:

| Surface | CLI | internal API | operator console |
| --- | --- | --- | --- |
| Space CRUD | yes | yes | yes |
| Catalog release assignment | yes | yes | yes |
| SpaceExportShare lifecycle | yes | yes | yes |
| Approval issue / revoke | optional | yes | yes |
| RevokeDebt resolution | yes | yes | yes |
| Runtime-agent enrollment | yes | yes | optional |
| Implementation registration | yes | yes | optional |
| Connector registration | yes | yes | optional |

The internal API is the canonical surface. The CLI and operator console are clients of that API. Public deploy clients never address operator surfaces.

## SLA observable surfaces

A 99.x% availability promise is an operator commitment, not a kernel guarantee. The kernel exposes the indicators that make such a promise auditable.

```text
apply latency                preview to OperationPlan accepted
activation latency           ActivationSnapshot prepared to GroupHead advanced
WAL replay time              kernel restart to journal-consistent steady state
drift detection latency      ObservationSet observedAt to DriftIndex emitted
RevokeDebt aging             RevokeDebt createdAt to status terminal transition
```

Each indicator is per-Space and time-bucketed. None of them are "alarm thresholds" at design level. They are the observable surface. Thresholding is operator policy.

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
  SpaceExportShare records
  secret-store partition references (not values)

regenerable (must not be relied on as authority)
  ObservationSet (re-observed)
  DriftIndex (recomputed)
  ExportMaterial cache (re-projected)
  generated objects whose source is intact
```

Restore rule: a restore is consistent only if recovery-critical backups are aligned to a common journal cut. Regenerable surfaces must be rebuilt from observation after restore, not restored from backup as authority.

## kernel-side primitives for tenant operations

The surfaces above (multi-tenant boundary, billing readiness, supply chain trust, operator UX, SLA observability, disaster recovery) describe what the kernel exposes for tenant-bearing service. The detailed rationale for the per-tenant primitives is split across three companion design docs, each scoped to one concern:

- [Identity and Access Design](./identity-and-access-design.md) — why Actor, Organization, Membership, RBAC, API keys, and auth providers are kernel primitives; why the role enum is closed and provider binding is immutable.
- [Tenant Lifecycle Design](./tenant-lifecycle-design.md) — why provisioning is a closed seven-stage idempotent sequence, why trial Spaces use a separate lifecycle, and how export and two-phase deletion preserve audit chain integrity.
- [PaaS Operations Design](./paas-operations-design.md) — why quota tiers are operator-named and kernel-enforced, why cost attribution is opaque metadata, why SLA detection and incidents are kernel-side, why support impersonation is a separate auth path, and why notifications are pull-only.

Together with the surfaces in this document, these three design docs define the kernel-side scope for v1 PaaS operation. Customer signup UIs, payment flows, status pages, branded notifications, ticket systems, SLA credit formulas, and admin escalation workflows compose on top of these primitives but live outside Takosumi (typically in `takos-private/` or another operator-owned distribution).

## Cross-references

- [Operator Boundaries](./operator-boundaries.md)
- [Space Model](./space-model.md)
- [Identity and Access Design](./identity-and-access-design.md)
- [Tenant Lifecycle Design](./tenant-lifecycle-design.md)
- [PaaS Operations Design](./paas-operations-design.md)
- [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
- [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [Operational Hardening Checklist](./operational-hardening-checklist.md)
- Reference: [CLI](../reference/cli.md), [Kernel HTTP API](../reference/kernel-http-api.md), [Lifecycle](../reference/lifecycle.md)
