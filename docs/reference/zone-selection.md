# Zone Selection

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Connector Contract](/reference/connector-contract),
> [Manifest Expand Semantics](/reference/manifest-expand-semantics),
> [Drift Detection](/reference/drift-detection),
> [Environment Variables](/reference/env-vars),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 zone attribute. The kernel treats a zone as an
**operator-defined string**, attaches it as metadata at Space, Object,
DataAsset, and Connector scope, and propagates it through manifest expansion,
drift detection, and the audit log. The kernel does not own a topology graph,
latency table, or zone-pricing model.

## Single-region invariant

All zones in a Takosumi v1 installation live inside **one region**. The kernel
enforces this invariant: cross-region links are out of scope for v1. An operator
distribution that wants to span multiple regions runs one Takosumi installation
per region and federates at the operator boundary, not inside the kernel.

Adding cross-region semantics — multi-region writes, region failover,
geo-routing — requires a `CONVENTIONS.md` §6 RFC.

## Zone model

A zone is a kebab-case ASCII string with the same suffix grammar as
operator-controlled IDs (see [Resource IDs](/reference/resource-ids)). Examples:
`az-1a`, `az-1b`, `rack-c`. The kernel does not interpret the value: two zones
with similar names are unrelated, and the kernel does not infer adjacency or
distance from the string shape.

Operators publish the set of zones they recognise through the environment:

```text
TAKOSUMI_ZONES_AVAILABLE   comma-separated list, e.g. "az-1a,az-1b,az-1c"
TAKOSUMI_ZONE_DEFAULT      one of TAKOSUMI_ZONES_AVAILABLE; required when
                           TAKOSUMI_ZONES_AVAILABLE is set
```

Setting `TAKOSUMI_ZONES_AVAILABLE` to a non-empty list activates zone checks.
Leaving it unset keeps the kernel zone-agnostic; in that mode every zone field
below is silently ignored at evaluation time.

When zone checks are active, every Space- / Object- / DataAsset- /
Connector-scoped zone value must be a member of `TAKOSUMI_ZONES_AVAILABLE`.
Unknown zones are rejected at write time with HTTP `400 Bad Request`.

## Zone attribute

Zone is attached at four scopes:

| Scope     | Field            | Notes                                                         |
| --------- | ---------------- | ------------------------------------------------------------- |
| Space     | `defaultZone`    | Default zone for objects in the Space.                        |
| Object    | `zone`           | Object-level override. Falls back to the Space `defaultZone`. |
| DataAsset | `zonePreference` | Soft preference for asset placement.                          |
| Connector | `zonePreference` | Soft preference for connector binding.                        |

`zone` is binding: the connector receives the resolved zone in the binding
context and must place the resource accordingly. `zonePreference` is advisory:
the connector consults the value when the underlying provider supports zone
hints, and emits an audit signal when the provider cannot honour the preference.

The Space record persists `defaultZone`. Object, DataAsset, and Connector
records persist their respective zone fields per
[Storage Schema](/reference/storage-schema).

## Manifest reference

Manifests reference zones through the standard `${ref:...}` expansion defined in
[Manifest Expand Semantics](/reference/manifest-expand-semantics):

```yaml
objects:
  - id: object:web
    zone: ${ref:space.defaultZone}
  - id: object:cache
    zone: az-1b
```

A target descriptor that declares `zoneAware: true` in its shape spec receives
the resolved zone string in the binding context. Descriptors that do not declare
zone awareness ignore the field; the kernel does not coerce or drop it.

## Cross-zone link policy

A link between two objects in the same Space whose resolved zones differ is a
**cross-zone link**. The default policy is `allow-with-warning`:

- The kernel emits a `cross-zone-link-warning` audit event with
  `severity: notice` carrying the link ID, the consumer zone, the producer zone,
  and the Space ID.
- The link itself is created and the deployment proceeds.

The policy is operator-tunable through `TAKOSUMI_CROSS_ZONE_LINK_POLICY`:

| Value                | Effect                                                     |
| -------------------- | ---------------------------------------------------------- |
| `allow`              | Permit cross-zone links silently; no audit event.          |
| `allow-with-warning` | Default. Permit and emit `notice`.                         |
| `deny`               | Reject the deployment with `errorCode: cross_zone_denied`. |

The policy applies kernel-globally. Per-Space policy overrides require a
`CONVENTIONS.md` §6 RFC.

## Failover signal

Zone-failure is a **signal surface**, not a kernel-driven failover mechanism.
The kernel does not move objects across zones autonomously.

- Connectors that detect a zone-down condition (provider API returning
  zone-specific failure, probe consistently failing inside one zone) emit
  `zone-failure-observed` to drift detection (see
  [Drift Detection](/reference/drift-detection)). The drift event carries the
  zone string and the affected object IDs.
- The next ActivationSnapshot built after a zone-failure observation carries an
  annotation `zoneFailure: { zone: "...", observedAt: ... }` on every affected
  object. The annotation is informational; the snapshot is still produced.
- Recovery is symmetrical: connectors emit `zone-recovery-observed` and the next
  ActivationSnapshot drops the annotation.

What the operator distribution does with the signal — failover an external load
balancer, redirect customer traffic, re-shape the desired manifest, post a
status page entry — lives outside the kernel. The kernel's job is to make the
signal observable and durable.

## Audit events

Zone-related audit events (see [Audit Events](/reference/audit-events)):

- `cross-zone-link-warning` — emitted on cross-zone link creation under
  `allow-with-warning`. Severity `notice`.
- `zone-failure-observed` — emitted on connector-reported zone failure. Severity
  `warning`.
- `zone-recovery-observed` — emitted on connector-reported zone recovery.
  Severity `notice`.
- `space-default-zone-changed` — emitted when a Space's `defaultZone` is
  updated. Severity `info`. Payload carries previous and next zone, and the
  actor.

`zone-failure-observed` and `zone-recovery-observed` carry both the Space ID and
the zone string. Kernel-global zone-failure (every Space affected) emits the
events with `spaceId` set to each Space in turn; the kernel does not collapse
them into a single event so that downstream consumers can attribute correctly.

## Storage

Zone fields persist on existing record classes consistent with
[Storage Schema](/reference/storage-schema):

| Record             | Field             | Required | Notes                                            |
| ------------------ | ----------------- | -------- | ------------------------------------------------ |
| Space              | `defaultZone`     | no       | Required when `TAKOSUMI_ZONES_AVAILABLE` is set. |
| Object             | `zone`            | no       | Falls back to Space `defaultZone`.               |
| DataAsset          | `zonePreference`  | no       | Soft preference.                                 |
| Connector          | `zonePreference`  | no       | Soft preference.                                 |
| ActivationSnapshot | `zoneAnnotations` | no       | Map of object ID to `{ zone, zoneFailure? }`.    |

Zone values are immutable inside an ActivationSnapshot — the snapshot freezes
the zone at activation time and is the canonical record for historical analysis.

## Operator boundary

This reference defines the kernel-side primitive: the zone attribute, its
propagation through manifests and snapshots, the cross-zone link policy, and the
failure / recovery signal. The **customer-visible zone product** — zone
selectors in a customer dashboard, latency tables and recommendation copy,
disaster-recovery playbooks, public status copy describing zone outages, and the
contract language that binds zone availability to commercial commitments — lives
in operator distributions such as `takos-private/`. The kernel ships the
attribute and the audit signal, and stops there.

## Related design notes

- `docs/design/operator-boundaries.md` — operator policy layer that acts on zone
  signals.
- `docs/design/exposure-activation-model.md` — ActivationSnapshot shape that
  carries zone annotations.
- `docs/design/space-model.md` — Space identity that owns `defaultZone`.
