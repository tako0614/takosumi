# Cost Attribution

> Stability: stable Audience: operator, integrator See also:
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Telemetry / Metrics](/reference/telemetry-metrics),
> [Compliance Retention](/reference/compliance-retention),
> [Quota / Rate Limit](/reference/quota-rate-limit),
> [Quota Tiers](/reference/quota-tiers),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

This reference defines the v1 cost-attribution metadata surface. The kernel
exposes a free-form **operator-controlled metadata map** on each Space and
propagates the map through audit events and telemetry labels, so that an
external billing pipeline can join kernel-emitted usage signals to
operator-defined accounting axes (cost center, project code, customer segment,
ad-hoc labels). The kernel does not ship a billing engine, an invoice surface, a
price book, or an opinion about what an attribution key means.

::: info Current HTTP status Cost attribution fields are model / service
contract fields. The current kernel HTTP router does not mount
`PATCH /api/internal/v1/spaces/:id` or query filters such as
`GET /api/internal/v1/spaces?costCenter=...`; see
[Kernel HTTP API — Internal control plane routes](/reference/kernel-http-api#internal-control-plane-routes).
:::

## Attribution metadata model

Each Space carries an optional `attribution` map:

| Field             | Type                | Required | Notes                                                                               |
| ----------------- | ------------------- | -------- | ----------------------------------------------------------------------------------- |
| `costCenter`      | string              | no       | Operator-defined cost center identifier.                                            |
| `projectCode`     | string              | no       | Operator-defined project or workstream code.                                        |
| `customerSegment` | string              | no       | Operator-defined segment label (for example `enterprise`, `internal`, `community`). |
| `customLabels`    | map<string, string> | no       | Free-form labels keyed by operator-controlled name.                                 |

All four fields are optional. The kernel never derives a value, never requires a
value, and never enforces a vocabulary. Every value is an opaque string from the
kernel's perspective.

The same model applies at organisation scope when the operator distribution
exposes orgs over the kernel: an organisation record carries the same
`attribution` shape and Spaces inside the org inherit nothing automatically —
the operator distribution decides whether to mirror org-level attribution down
into Space records at provisioning.

## Storage

Attribution metadata persists on the Space record as a map field, consistent
with [Storage Schema](/reference/storage-schema). Keys under `customLabels` are
stored verbatim; the kernel does not lower- case or normalise them. Operators
that want a stable label namespace adopt a prefix convention (for example
`cc:engineering`, `segment:enterprise`) and apply it at the operator policy
layer.

Per-key value caps:

- `costCenter`, `projectCode`, `customerSegment`: 128 characters.
- `customLabels` keys: 64 characters each, kebab-case ASCII or the reserved
  colon prefix shape `<namespace>:<value>`.
- `customLabels` values: 256 characters each.
- The whole map: 32 entries and 8 KiB serialised.

Values exceeding the caps are rejected at write time with HTTP
`400 Bad Request`. The kernel does not silently truncate.

## Update API

In the spec-reserved internal HTTP surface, attribution metadata is mutated
through:

```text
PATCH /api/internal/v1/spaces/:id
{
  "attribution": {
    "costCenter": "cc:platform",
    "projectCode": "proj:payments-2026",
    "customerSegment": "enterprise",
    "customLabels": {
      "owner": "team-a",
      "billing-contact": "ar+platform@example.invalid"
    }
  }
}
```

Update semantics:

- A `PATCH` replaces the full `attribution` map. Partial mutation is not
  supported; clients re-send the full intended map. This matches the kernel's
  preference for explicit, replay-safe state transitions.
- Setting a field to `null` removes the field. Setting `attribution` itself to
  `null` clears the entire map.
- The kernel **rejects retroactive intent**: a `PATCH` applies to all audit
  events and telemetry samples emitted at-or-after the patch commit timestamp.
  Past audit rows and past telemetry samples retain the attribution that was
  current when they were emitted. There is no rewrite path.

## Audit propagation

Every audit event whose envelope carries a `spaceId` (see
[Audit Events](/reference/audit-events)) additionally carries the Space's
current `attribution` snapshot in the event payload under the fixed key
`attribution`. The snapshot is taken at event-write time and is part of the
canonical bytes that feed the audit hash chain.

A new audit event type tracks attribution mutation itself:

- `space-attribution-changed` — payload carries `spaceId`, the previous map, the
  next map, and the actor.

Attribution stays in the audit log for the full retention window declared by the
Space's compliance regime (see
[Compliance Retention](/reference/compliance-retention)). When retention drops
an audit row, attribution drops with it; the kernel does not maintain an
out-of-band attribution archive.

## Telemetry labels

The OTLP and Prometheus exporters defined in
[Telemetry / Metrics](/reference/telemetry-metrics) attach attribution as
resource attributes / labels on every Space-scoped metric and span:

```text
takosumi_space_id          required
takosumi_quota_tier_id     required
takosumi_cost_center       optional
takosumi_project_code      optional
takosumi_customer_segment  optional
```

The `customLabels` map is **not** emitted as labels by default. An operator who
wants a custom label exported promotes it through the
`TAKOSUMI_TELEMETRY_ATTRIBUTION_PROMOTE` environment variable, which takes a
comma-separated list of `customLabels` keys to promote to a metric label.
Promotion is rejected for keys whose observed cardinality in the kernel exceeds
the operator-tunable `TAKOSUMI_TELEMETRY_ATTRIBUTION_MAX_CARDINALITY` (default
`200`).

The kernel emits a `severity: warning` audit event
`telemetry-cardinality-warning` when a promoted key crosses the threshold and
stops promoting that key until the operator either raises the threshold or
removes the key from the promote list.

## Reporting query

In the spec-reserved internal API, operators read attribution through:

- `GET /api/internal/v1/spaces?costCenter=cc:platform`
- `GET /api/internal/v1/spaces?customerSegment=enterprise`
- `GET /api/internal/v1/spaces?customLabel=owner:team-a`

The kernel returns the matching Space records. **Aggregation, grouping, totals,
and chart rendering are out of scope**: operators join the audit log against the
queried Space set in their downstream pipeline.

## Privacy

Attribution metadata persists in the audit log and in telemetry exports for the
retention window of each respective surface. Operators are responsible for
keeping personally identifying information out of attribution. The kernel does
not run a PII classifier and does not redact attribution values on read.

When a regulated regime applies (see
[Compliance Retention](/reference/compliance-retention)), the operator policy
layer SHOULD reject attribution writes whose values look like email addresses,
phone numbers, or other PII at request ingest. The kernel exposes the raw write
path so policy can run there.

## Operator boundary

This reference defines the kernel-side primitive: the metadata field, the update
API, the audit propagation, and the telemetry promotion contract. The
**end-to-end cost workflow** — pulling the audit log into a billing system,
joining attribution to a customer record, running price-book maths, generating
invoices, surfacing per-cost- center dashboards, and reconciling against
external accounting systems — lives in operator distributions such as
`takos-private/` and in the billing pipeline an operator wires up. The kernel
ships the metadata surface and stops there.

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that consumes attribution-tagged signals.
- `docs/reference/architecture/space-model.md` — Space identity that owns
  attribution.
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  audit emission point where attribution snapshots are captured.
