# Quota Tiers

> Stability: stable Audience: operator, kernel-implementer See also:
> [Quota / Rate Limit](/reference/quota-rate-limit),
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Environment Variables](/reference/env-vars),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 quota tier model. The kernel exposes a **tier
attribute** that operators attach to a Space; the dimensional caps that the tier
resolves to are operator-defined and live entirely in operator policy. The
kernel does not ship a price book, a free / pro / enterprise ladder, or any
built-in commercial semantics.

::: info Current HTTP status The quota-tier registration and assignment
endpoints in this reference are a spec / service contract. The current kernel
HTTP router does not mount `/api/internal/v1/quota-tiers` or
`PATCH /api/internal/v1/spaces/:id`; see
[Kernel HTTP API — Spec-Reserved Internal Surfaces](/reference/kernel-http-api#spec-reserved-internal-surfaces).
:::

## Tier model

A quota tier is a named bundle of dimension caps. Each Space carries exactly one
`quotaTierId`. When the kernel evaluates a quota dimension for a Space, it
resolves the dimension cap through the Space's tier record and applies the same
fail-closed-for-new-work, fail-open-for- inflight semantics defined in
[Quota / Rate Limit](/reference/quota-rate-limit).

- `quotaTierId` is a string with the same kebab-case suffix grammar as other
  operator-controlled IDs (see [Resource IDs](/reference/resource-ids)). The
  suffix is operator-chosen, for example `tier:free`, `tier:pro`,
  `tier:internal`. The kernel does not interpret the suffix.
- The tier set is **flat in v1**: there is no inheritance, no parent tier, and
  no tier composition. Each Space resolves to one tier and one tier only.
- Tier records are persisted in the partition declared in
  [Storage Schema](/reference/storage-schema) and survive kernel restart,
  journal compaction, and restore from backup.

The kernel ships **no default tiers**. Operators register at least one tier
during bootstrap; an installation that has zero registered tiers fails closed at
boot and refuses Space provisioning.

## Tier dimensions

A tier carries a cap for each dimension in the closed v1 quota set:

| Dimension                         | Source                                             |
| --------------------------------- | -------------------------------------------------- |
| `deployment-count`                | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `active-object-count`             | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `artifact-storage-bytes`          | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `journal-volume-bytes-per-bucket` | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `approval-pending-count`          | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `space-export-share-count`        | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `cpu-milliseconds`                | Usage projection: `runtime.*_milliseconds`.        |
| `storage-bytes`                   | Usage projection: `resource.storage_bytes`.        |
| `bandwidth-bytes`                 | Usage projection: `runtime.bandwidth_bytes`.       |

A tier may additionally declare per-tier rate-limit overrides for the public and
internal route classes. Rate-limit overrides are optional; when omitted, the
Space resolves to the kernel-wide defaults from `TAKOSUMI_RATE_LIMIT_*`.

The service-level `LocalUsageQuotaPolicy` used by embedded / self-hosted
deployments resolves these three usage dimensions per Space before usage is
recorded. `UsageProjectionService.requireWithinQuota()` rejects a projected
counter that would exceed the tier cap, so CPU / storage / bandwidth gates can
fail closed before downstream billing projection or provider scheduling.

A cap value of the literal string `unlimited` means the tier removes the cap for
that dimension. A cap of `0` is rejected at registration time.

## Tier registration API

The spec-reserved tier registration API is operator-only and lives on the
internal HTTP surface (see [Kernel HTTP API](/reference/kernel-http-api)).

`POST /api/internal/v1/quota-tiers`

Request body:

```json
{
  "tierId": "tier:pro",
  "dimensions": {
    "deploymentCount": 100,
    "activeObjectCount": 1000,
    "artifactStorageBytes": 107374182400,
    "journalVolumeBytesPerBucket": 1073741824,
    "approvalPendingCount": 50,
    "spaceExportShareCount": 25
  },
  "rateLimitOverrides": {
    "publicPerSpaceRps": 30,
    "internalPerSpaceRps": 90
  }
}
```

Response:

```json
{ "tierId": "tier:pro", "createdAt": "2026-05-05T00:00:00.000Z" }
```

Other endpoints:

- `GET /api/internal/v1/quota-tiers` lists every registered tier.
- `GET /api/internal/v1/quota-tiers/:tierId` returns one tier.
- `PATCH /api/internal/v1/quota-tiers/:tierId` updates the dimension caps or the
  rate-limit overrides. The `tierId` field is immutable.
- `DELETE /api/internal/v1/quota-tiers/:tierId` removes a tier. The kernel
  rejects deletion when any Space still references the tier; operators migrate
  every referencing Space to another tier first.

All four mutating calls fail closed when the caller's auth context is not in the
operator role.

## Tier assignment to Space

A Space carries a `quotaTierId` field. The field is required at Space
provisioning: a Space cannot exist without a resolved tier.

- Initial assignment happens at Space creation; the request must reference an
  already-registered `tierId`.
- Reassignment uses
  `PATCH /api/internal/v1/spaces/:id { "quotaTierId": "tier:..." }`.
- The kernel applies the new tier on the next quota evaluation; it does not
  retroactively rewrite past audit counters or past ActivationSnapshots.
- Reassignment that lowers a cap below the Space's current usage does not roll
  back inflight work. New work that would push the Space past the new cap fails
  closed under the standard quota path.

## Bootstrap requirement

The bootstrap protocol (see [Bootstrap Protocol](/reference/bootstrap-protocol))
requires the operator to register at least one tier before the kernel will
accept Space provisioning. The convention is to register `tier:default` and bind
every Space to it until the operator introduces additional tiers; the suffix is
not enforced and operators may pick any kebab-case name.

`TAKOSUMI_QUOTA_TIER_BOOTSTRAP_REQUIRED` (default `true`) controls the boot-time
check. Disabling it is permitted for local-mode operator testing only and is
rejected at boot in `production`.

## Audit events

Tier lifecycle emits the following audit events (see
[Audit Events](/reference/audit-events)):

- `quota-tier-registered` — payload carries `tierId` and the full dimension and
  rate-limit cap snapshot.
- `quota-tier-updated` — payload carries `tierId`, the previous cap snapshot,
  and the new cap snapshot.
- `quota-tier-removed` — payload carries `tierId` and the cap snapshot at
  removal time.
- `space-tier-changed` — payload carries `spaceId`, `previousTierId`,
  `nextTierId`, and the actor that performed the change.

Tier-level events carry a null `spaceId`; `space-tier-changed` carries the
affected Space.

## Storage

Tier records persist as a dedicated record class consistent with
[Storage Schema](/reference/storage-schema):

| Field                | Type      | Required | Notes                                         |
| -------------------- | --------- | -------- | --------------------------------------------- |
| `tierId`             | string    | yes      | Operator-controlled kebab-case ID. Immutable. |
| `dimensions`         | object    | yes      | Map of dimension name to cap.                 |
| `rateLimitOverrides` | object    | no       | Optional rate-limit override map.             |
| `createdAt`          | timestamp | yes      | Set on registration.                          |
| `updatedAt`          | timestamp | yes      | Updated on every `PATCH`.                     |

The Space record carries `quotaTierId` as a foreign reference. Quota counters
themselves remain on the Space record; the tier only supplies the cap that the
counter is compared against.

## Operator boundary

This reference defines the kernel-side primitive: the tier model, the
registration API, the assignment surface, and the audit shape. The **commercial
semantics** that bind a tier to a customer plan — pricing in any currency,
contract clauses, dunning policy, free-to-paid upgrade flows, dashboard
rendering of tier comparisons, and tier-aware billing exports — live in operator
distributions such as `takos-private/` and in third-party billing systems
consuming the kernel audit log. The kernel does not encode any of those
concepts.

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that consumes tier-resolved quota signals.
- `docs/reference/architecture/space-model.md` — Space identity that scopes tier
  assignment.
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  quota evaluation point against tier-resolved caps.
