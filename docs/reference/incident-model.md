# Incident Model

> Stability: stable Audience: operator, kernel-implementer See also:
> [Audit Events](/reference/audit-events),
> [Storage Schema](/reference/storage-schema),
> [RevokeDebt Model](/reference/revoke-debt),
> [Quota and Rate Limit](/reference/quota-rate-limit),
> [Readiness Probes](/reference/readiness-probes),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 Incident primitive: a kernel-side record of a
service-impacting event, the closed state machine that governs its lifecycle,
the auto-detection triggers that mint incidents from existing kernel signals,
the operator and customer visibility rules, and the audit chain that records
every state transition. The kernel ships the incident record, the state machine,
and the audit primitives. Customer-facing status pages, incident timeline
visualization, and notification rendering are out of scope for the kernel.

::: info Current HTTP status The incident endpoints in this reference are a spec
/ service contract. The current kernel HTTP router does not mount
`/api/internal/v1/incidents` or `/api/internal/v1/spaces/:id/incidents`; see
[Kernel HTTP API — Spec-Reserved Internal Surfaces](/reference/kernel-http-api#spec-reserved-internal-surfaces).
:::

## Incident definition

An Incident is a kernel-recorded service-impacting event that satisfies one of
two origin conditions:

- **Auto-detected** from a kernel-side measurable signal: an SLA breach,
  RevokeDebt aging into `operator-action-required`, a readiness probe failure
  rate above threshold, or a sustained internal-error rate above threshold.
- **Operator-declared** through the internal control plane when an outer-layer
  signal (customer report, third-party dependency outage, operator-side change
  failure) needs to be tracked through the same state machine and audit chain.

Both origins produce the same record shape and traverse the same state machine.
Origin is recorded on the record so operators can slice incident review by
detection source.

## Incident record

```yaml
Incident:
  id: incident:01HM9N7XK4QY8RT2P5JZF6V3W9
  title: "deployment apply latency p99 above SLO"
  state: detecting # closed enum below
  severity: high # closed enum below
  origin: auto-detected # or operator-declared
  affectedSpaceIds:
    - space:acme-prod
  affectedOrgIds:
    - organization:acme
  kernelGlobal: false
  detectedAt: 2026-05-05T07:43:11.214Z
  acknowledgedAt: null
  mitigatedAt: null
  resolvedAt: null
  rootCause: null
  relatedAuditEventIds:
    - 01HM9N7XK4QY8RT2P5JZF6V3W7
    - 01HM9N7XK4QY8RT2P5JZF6V3W8
```

Field semantics:

| Field                  | Required | Notes                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | yes      | `incident:<ulid>` form. Kernel-minted at create. Immutable.                                                                                       |
| `title`                | yes      | Operator-editable label. Auto-detected incidents receive a default title derived from the trigger (for example, `sla-breach: apply-latency-p99`). |
| `state`                | yes      | Closed v1 enum (see below).                                                                                                                       |
| `severity`             | yes      | Closed v1 enum (see below). Auto-detected severity is computed from the trigger; operator may raise but not lower without an audit reason.        |
| `origin`               | yes      | Closed enum: `auto-detected`, `operator-declared`. Immutable.                                                                                     |
| `affectedSpaceIds`     | yes      | List of Space ids whose customer-visible behavior is impacted. Empty when `kernelGlobal` is true.                                                 |
| `affectedOrgIds`       | yes      | Derived list of Organizations owning the affected Spaces. Recomputed on Space-set change.                                                         |
| `kernelGlobal`         | yes      | Boolean. `true` when the incident affects kernel-host scope (every Space). `affectedSpaceIds` must be empty in that case.                         |
| `detectedAt`           | yes      | RFC 3339 UTC, millisecond precision. Set at create.                                                                                               |
| `acknowledgedAt`       | no       | Set when `state` first becomes `acknowledged`.                                                                                                    |
| `mitigatedAt`          | no       | Set when `state` first becomes `mitigating`.                                                                                                      |
| `resolvedAt`           | no       | Set when `state` first becomes `resolved`. Required before `postmortem`.                                                                          |
| `rootCause`            | no       | Free-form structured text. Populated only in `postmortem`; required to leave `postmortem` as terminal-published.                                  |
| `relatedAuditEventIds` | yes      | Chain back to the source audit events that triggered detection or that were emitted under this incident. May grow as the incident advances.       |

The kernel rejects mutation of `id`, `origin`, `detectedAt`, or `kernelGlobal`
after create.

## State machine

The v1 state enum is closed:

```text
detecting | acknowledged | mitigating | monitoring | resolved | postmortem
```

```text
detecting --(operator-ack | auto-ack)--> acknowledged
acknowledged --(operator-action)--> mitigating
mitigating --(operator-action)--> monitoring
monitoring --(operator-action)--> resolved
monitoring --(regression)--> mitigating
resolved --(operator-publishes)--> postmortem
```

State semantics:

- `detecting`: kernel has minted the incident from a trigger but no operator has
  yet acknowledged it. Customer-visibility is suppressed in this state; the
  record is internal-only.
- `acknowledged`: operator has confirmed the incident is real. From this state
  forward, the record is visible to affected customers through the read-only
  customer query (below).
- `mitigating`: operator is applying remediation. Customer visibility remains.
- `monitoring`: remediation has been applied; operator is observing for
  regression before declaring resolved.
- `resolved`: operator has declared the impact ended. `resolvedAt` is set.
  Customer visibility shifts to "resolved" framing.
- `postmortem`: operator has published a structured root-cause record
  (`rootCause` populated). Terminal in v1.

Transition rules:

- `detecting` may auto-ack to `acknowledged` if the operator opts in via the
  auto-acknowledge policy on the trigger family. Otherwise acknowledgement is
  operator-initiated.
- `monitoring` may regress to `mitigating` an unbounded number of times before
  reaching `resolved`. Each regression is an audit event.
- `postmortem` is terminal. Editing the published root cause requires a new
  incident referencing the previous one.

Severity enum (closed v1):

```text
low | medium | high | critical
```

- `low`: degraded internal metric, no customer-visible impact.
- `medium`: scoped customer impact (single Space, partial surface).
- `high`: broad customer impact across multiple Spaces in one Organization or
  across the kernel-global readiness probe.
- `critical`: kernel-global outage or compliance-relevant data path failure.

Severity is computed at detection from the trigger family and is adjustable by
the operator. A severity raise records an audit event with reason. A severity
lower also records an audit event and requires the same authorization scope as
state transitions.

## Auto-detection triggers

The kernel mints incidents from the following families. Each family maps to a
default severity and an auto-acknowledge default that the operator may override
per Space.

| Trigger family                         | Source signal                                                         | Default severity | Default auto-ack |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------- | ---------------- |
| `sla-breach`                           | SLA breach detected on a published SLO                                | derived          | no               |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` count above threshold | medium           | no               |
| `readiness-probe-failure-rate`         | `/readyz` failing above the operator-tunable threshold for the window | high             | yes              |
| `error-rate-sustained`                 | DomainErrorCode `internal_error` rate sustained above threshold       | medium           | no               |

Trigger detail:

- **SLA breach**: severity is derived from the breached SLO's declared
  customer-impact tier. The kernel attaches the breach signal id to
  `relatedAuditEventIds`.
- **RevokeDebt aging**: thresholds are configured per Space in the policy pack.
  The default is `>= 1` aged debt for medium severity; operators tune up or
  down. A new aged debt entering the same open incident extends
  `relatedAuditEventIds` rather than minting a new incident.
- **Readiness probe failure rate**: kernel-global by construction. Sets
  `kernelGlobal: true` and clears `affectedSpaceIds`.
- **Sustained error rate**: per-Space when the error stream carries a Space
  scope; kernel-global otherwise.

The kernel deduplicates auto-detected incidents within a sliding window per
`(trigger family, scope)` tuple. A second matching trigger within the window
appends to the open incident; outside the window, a new incident is minted.

## Operator actions

The spec-reserved operator-only endpoints run through the internal control
plane, gated by HMAC (see [Kernel HTTP API](/reference/kernel-http-api)):

- `POST /api/internal/v1/incidents` — declare an operator-declared incident.
  Body fields: `title`, `severity`, `affectedSpaceIds` or `kernelGlobal`,
  optional `relatedAuditEventIds`.
- `PATCH /api/internal/v1/incidents/:id` — advance state, edit title, adjust
  severity, add to `affectedSpaceIds` or `relatedAuditEventIds`. The kernel
  rejects transitions that violate the state machine.
- `POST /api/internal/v1/incidents/:id/postmortem` — publish the root-cause
  record. Requires `state = resolved`. Sets `state =
  postmortem` and freezes
  the record.
- `GET /api/internal/v1/incidents` — list with cursor pagination and filters on
  `state`, `severity`, `origin`, time window, `spaceId`.

## Customer-affecting query

A read-only customer query exposes incidents whose `state` is `acknowledged` or
beyond and whose `affectedSpaceIds` includes a Space the caller is authorized to
read:

- `GET /api/internal/v1/spaces/:id/incidents` — list incidents scoped to the
  Space. Returns `id`, `title`, `state`, `severity`, `detectedAt`,
  `acknowledgedAt`, `mitigatedAt`, `resolvedAt`, `rootCause` (only when
  `state = postmortem`).

The query suppresses incidents in `detecting` regardless of access:
auto-detected incidents that are later determined to be false positives never
become customer-visible.

`kernelGlobal` incidents are returned for every Space query whose caller is
authorized for any Space in the kernel.

## Audit events

Every state transition emits an audit event. The v1 incident audit event
taxonomy is closed and joins the [Audit Events](/reference/audit-events) closed
enum:

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

Each event carries the standard envelope plus an incident-payload recording
`{incidentId, fromState, toState, fromSeverity, toSeverity,
relatedAuditEventIds}`
where applicable. The kernel rejects an audit write whose state pair is not a
valid transition.

## Storage schema

Incident extends [Storage Schema](/reference/storage-schema) with one record
class:

| Record     | Indexed by                                                          | Persistence                                                        |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Incident` | `(id)`, `(state)`, `(detectedAt)`, `(spaceId via affectedSpaceIds)` | Kept indefinitely under audit retention; `postmortem` is terminal. |

Implementations may co-locate the incident store with the audit store but must
keep the indexed columns above.

## Scope boundary

The spec surface includes the incident record, the state machine, the
auto-detection triggers, the operator and customer-read endpoints listed above,
and the audit chain. The current kernel repository does not mount those HTTP
routes. Public-facing status page UI, customer notification template rendering,
incident timeline visualization, third-party paging integration, on-call
rotation, and ticket-tracker linkage are **outside Takosumi's scope** and are
implemented by the operator's outer stack (for example, `takos-private/` or any
other PaaS-provider front end). The kernel exposes the storage and audit
primitives that those outer surfaces compose against.

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator vs. customer
  visibility rules referenced by the customer-affecting query.
- `docs/reference/architecture/policy-risk-approval-error-model.md` — severity
  derivation and trigger family mapping.
- `docs/reference/architecture/observation-drift-revokedebt-model.md` —
  RevokeDebt aging trigger source.
