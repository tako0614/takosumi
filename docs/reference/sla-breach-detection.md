# SLA Breach Detection

> Stability: stable Audience: operator, kernel-implementer See also:
> [Telemetry / Metrics](/reference/telemetry-metrics),
> [Audit Events](/reference/audit-events),
> [Storage Schema](/reference/storage-schema),
> [Readiness Probes](/reference/readiness-probes),
> [Quota / Rate Limit](/reference/quota-rate-limit),
> [Drift Detection](/reference/drift-detection),
> [RevokeDebt](/reference/revoke-debt),
> [Time / Clock Model](/reference/time-clock-model),
> [Environment Variables](/reference/env-vars),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

This reference defines the v1 SLA breach detection surface. The kernel measures
a closed set of latency, throughput, and error dimensions over rolling windows,
evaluates each dimension against operator- supplied thresholds, and emits audit
events whenever a dimension crosses into or out of breach. The kernel does not
compute service credits, render status pages, or own the customer communication
path.

::: info Current HTTP status The SLA threshold and query endpoints in this
reference are a spec / service contract. The current kernel HTTP router does not
mount `/api/internal/v1/sla`; see
[Kernel HTTP API — Spec-Reserved Internal Surfaces](/reference/kernel-http-api#spec-reserved-internal-surfaces).
:::

## SLA dimensions (closed v1 set)

The v1 measurement set is closed. Adding a dimension goes through the
`CONVENTIONS.md` §6 RFC.

| Dimension                   | Source                                            | Notes                                                               |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `apply-latency-p50`         | `takosumi_apply_duration_seconds`                 | Median apply latency over the window.                               |
| `apply-latency-p95`         | `takosumi_apply_duration_seconds`                 | 95th percentile.                                                    |
| `apply-latency-p99`         | `takosumi_apply_duration_seconds`                 | 99th percentile.                                                    |
| `activation-latency`        | activation pipeline                               | Time from `desired-recorded` to `activation-snapshot-created`.      |
| `wal-stage-duration`        | [WAL Stages](/reference/wal-stages)               | One observation per stage; emitted per stage independently.         |
| `drift-detection-latency`   | [Drift Detection](/reference/drift-detection)     | Time from drift cause to `drift-detected`.                          |
| `revoke-debt-aging`         | [RevokeDebt](/reference/revoke-debt)              | Median age between `revoke-debt-created` and `revoke-debt-cleared`. |
| `readiness-up-ratio`        | [Readiness Probes](/reference/readiness-probes)   | Fraction of probe samples reporting `ok`.                           |
| `rate-limit-throttle-ratio` | [Quota / Rate Limit](/reference/quota-rate-limit) | Ratio of 429-rejected requests to total requests.                   |
| `error-rate-5xx`            | HTTP edge                                         | Ratio of HTTP 5xx responses to total responses.                     |
| `error-rate-4xx`            | HTTP edge                                         | Ratio of HTTP 4xx responses to total responses.                     |

Each dimension is observed at the kernel HTTP edge or at the worker boundary
that already emits the corresponding telemetry metric in
[Telemetry / Metrics](/reference/telemetry-metrics). Breach detection re-uses
the same observation; it does not introduce a parallel measurement path.

## Measurement window

Every dimension is evaluated over a rolling window:

- Default window length: 5 minutes.
- Operator-tunable through `TAKOSUMI_SLA_WINDOW_SECONDS` (allowed range:
  60–3600, integer seconds).
- Sub-windows of 30 seconds form the sliding aggregation buckets; evaluation
  runs at the end of every sub-window boundary.
- All windows align to the kernel monotonic clock declared in
  [Time / Clock Model](/reference/time-clock-model) so that successive windows
  do not overlap or drop samples on clock skew.

Per-dimension overrides are allowed through
`TAKOSUMI_SLA_WINDOW_SECONDS_<DIMENSION>` (uppercase, dashes converted to
underscores). Operators that want a longer window for a high-volume dimension
and a shorter one for a low-traffic dimension configure each independently.

## Threshold and breach criterion

Thresholds are **operator-supplied**. The kernel ships no built-in threshold; an
installation that has not registered any threshold emits no breach events.

Design-reserved threshold registration endpoint:

`POST /api/internal/v1/sla/thresholds`

```json
{
  "dimension": "apply-latency-p95",
  "comparator": "gt",
  "value": 5.0,
  "scope": "kernel-global",
  "windowSeconds": 300
}
```

- `comparator` is one of `gt`, `gte`, `lt`, `lte`. The kernel does not invent
  comparators outside this closed set.
- `value` is a non-negative number; the unit follows the source metric (seconds
  for latency, ratio for ratios).
- `scope` is one of `kernel-global`, `space`, `org`. Space- or org- scoped
  thresholds carry an additional `targetId` field.
- `windowSeconds` overrides the default window for this threshold.

Mutating endpoints `PATCH` and `DELETE` accept the same body shape keyed by
`thresholdId`. The kernel persists thresholds in the audit partition consistent
with [Storage Schema](/reference/storage-schema).

## State machine and hysteresis

Each (dimension, scope, target) tuple carries a state machine:

```text
ok → warning → breached → recovering → ok
```

Transitions:

- `ok → warning` when the observation exceeds the threshold for one sub-window.
- `warning → breached` when the observation exceeds the threshold for
  `TAKOSUMI_SLA_BREACH_CONSECUTIVE_WINDOWS` (default `2`) consecutive
  sub-windows.
- `breached → recovering` when the observation returns under the threshold for
  one sub-window.
- `recovering → ok` when the observation stays under the threshold for
  `TAKOSUMI_SLA_RECOVERY_CONSECUTIVE_WINDOWS` (default `3`) consecutive
  sub-windows.

The `warning` and `recovering` states implement hysteresis: a single off-window
observation does not flap the dimension into or out of `breached`, which keeps
audit volume and downstream paging predictable.

## Breach attribution

Every state-change event carries scope information so that downstream consumers
can tell apart Space-, org-, and kernel-global breaches:

- `scope: space` — payload carries `spaceId`. Indicates a tenant- visible breach
  attributable to a single Space's traffic shape or to a per-Space resource
  path.
- `scope: org` — payload carries `orgId` when an operator distribution exposes
  orgs.
- `scope: kernel-global` — payload carries no tenant ID. Indicates an
  operator-side root cause (storage, network, runtime-agent).

The same dimension may breach at multiple scopes simultaneously. State machines
are independent per (dimension, scope, target).

## Reporting surface

In the spec-reserved internal HTTP surface, operators read SLA state through:

`GET /api/internal/v1/sla`

```json
{
  "windowEnd": "2026-05-05T00:05:00.000Z",
  "dimensions": [
    {
      "dimension": "apply-latency-p95",
      "scope": "kernel-global",
      "state": "ok",
      "lastObservation": 1.42
    }
  ],
  "breaches": [
    {
      "thresholdId": "sla-threshold:01HZ...",
      "dimension": "apply-latency-p99",
      "scope": "space",
      "spaceId": "space:tenant-a",
      "state": "breached",
      "openedAt": "2026-05-05T00:01:30.000Z",
      "lastObservation": 8.7
    }
  ]
}
```

Filtering accepts `dimension`, `scope`, `spaceId`, `orgId`, and `state` query
parameters. The endpoint is read-mostly and never mutates state.

## Audit events

State machine transitions emit closed-enum audit events (see
[Audit Events](/reference/audit-events)):

- `sla-breach-detected` — emitted on `warning → breached`. Payload carries
  `thresholdId`, `dimension`, `scope`, `targetId`, `windowSeconds`,
  `observation`, `comparator`, and `value`.
- `sla-warning-raised` — emitted on `ok → warning`. Same payload.
- `sla-recovering` — emitted on `breached → recovering`.
- `sla-recovered` — emitted on `recovering → ok`. Carries
  `breachDurationSeconds`.
- `sla-threshold-registered` / `sla-threshold-updated` / `sla-threshold-removed`
  — emitted on threshold mutation. Payload carries the threshold snapshot before
  and after.

Severity mapping: `sla-warning-raised` is `notice`, `sla-breach-detected` is
`warning`, `sla-recovered` is `notice`, and threshold mutation events are
`info`. Operators escalate to paging through their downstream alerting layer.

## Storage

SLA state persists as a dedicated record class consistent with
[Storage Schema](/reference/storage-schema):

| Field         | Type      | Required | Notes                                         |
| ------------- | --------- | -------- | --------------------------------------------- |
| `id`          | string    | yes      | `sla-observation:<ULID>`.                     |
| `dimension`   | enum      | yes      | Closed v1 dimension.                          |
| `scope`       | enum      | yes      | `kernel-global` / `space` / `org`.            |
| `targetId`    | string    | no       | Required when scope is not kernel-global.     |
| `state`       | enum      | yes      | `ok` / `warning` / `breached` / `recovering`. |
| `enteredAt`   | timestamp | yes      | When the current state was entered.           |
| `observation` | number    | yes      | Most recent sub-window observation.           |
| `thresholdId` | string    | yes      | Reference to the active threshold.            |

Threshold records persist alongside SLAObservation records and follow the same
retention as quota counters: read-mostly, outside the OperationJournal, retained
until explicitly removed.

## Operator boundary

This reference defines the kernel-side primitive: the closed measurement set,
the rolling-window evaluation, the state machine, the threshold registration
API, and the audit shape. The **commercial SLA workflow** — service credit
calculation in any currency, contract-specific carve-outs, scheduled-maintenance
exclusions, public status page rendering, customer-facing incident write-ups,
and post-incident communication templates — lives in operator distributions such
as `takos-private/`. The kernel ships detection and audit, and stops there.

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that acts on breach signals.
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  apply pipeline that produces apply-latency observations.
- `docs/reference/architecture/exposure-activation-model.md` — activation
  pipeline that produces activation-latency observations.
