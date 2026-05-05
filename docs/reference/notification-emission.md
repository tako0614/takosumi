# Notification Emission

> Stability: stable Audience: operator, integrator, kernel-implementer See also:
> [Audit Events](/reference/audit-events),
> [Actor / Organization Model](/reference/actor-organization-model),
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [RevokeDebt Model](/reference/revoke-debt),
> [Quota and Rate Limit](/reference/quota-rate-limit),
> [Incident Model](/reference/incident-model),
> [Migration / Upgrade](/reference/migration-upgrade),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Storage Schema](/reference/storage-schema),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 notification signal surface: the kernel-side
record the kernel emits when a downstream operator notification path should
fire, the closed category enum, the recipient resolution rule, the pull-only
delivery integration model, the idempotency rule that suppresses duplicate
signals, and the audit primitives. The kernel emits signals; concrete email,
Slack, SMS, in-app, and digest delivery live outside the kernel.

::: info Current HTTP status The notification pull endpoints in this reference
are a design / service contract. The current kernel HTTP router does not mount
`/api/internal/v1/notifications`; see
[Kernel HTTP API — Design-Reserved Internal Surfaces](/reference/kernel-http-api#design-reserved-internal-surfaces).
:::

## Notification model

The kernel does not deliver notifications. It records a structured signal
whenever a kernel-side event meets the criteria for one of the closed v1
categories. Operators consume the signal queue and fan out to their own delivery
channels.

Two consequences of this model:

- The kernel never holds SMTP, Slack, or webhook credentials. Deferring delivery
  to the operator's outer stack matches the same credential boundary used for
  shape providers (see the project AGENTS.md).
- Every notification that customers see has a corresponding kernel audit event.
  The operator's outer stack cannot mint a customer-visible notification that
  the kernel did not first emit as a signal.

Signals are a curated subset of the [Audit Events](/reference/audit-events)
stream plus a small number of derived events (for example,
`approval-near-expiry` is derived from approval TTL and is not a raw audit event
on its own).

## Signal categories

The v1 category enum is closed:

```text
approval-pending
approval-near-expiry
revoke-debt-operator-action-required
quota-near-limit
sla-breach-detected
incident-acknowledged
incident-resolved
space-trial-expiring
api-key-expiring
migration-completed
migration-rollback
```

Trigger detail:

| Category                               | Trigger                                                                                                      | Default severity |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| `approval-pending`                     | Approval issued and not yet consumed; emitted at issue and re-emitted at TTL milestones.                     | notice           |
| `approval-near-expiry`                 | Approval has consumed 50% and again at 90% of its TTL without being consumed.                                | warning          |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` (see [RevokeDebt Model](/reference/revoke-debt)).            | warning          |
| `quota-near-limit`                     | Quota counter reached 80% and again at 95% of cap (see [Quota and Rate Limit](/reference/quota-rate-limit)). | warning          |
| `sla-breach-detected`                  | SLA breach with severity `medium` or higher.                                                                 | warning          |
| `incident-acknowledged`                | An incident moved into `acknowledged` (see [Incident Model](/reference/incident-model)).                     | notice           |
| `incident-resolved`                    | An incident moved into `resolved`.                                                                           | notice           |
| `space-trial-expiring`                 | Trial Space at 7d, 1d, and 1h before expiry.                                                                 | notice           |
| `api-key-expiring`                     | API key TTL approaching at operator-tunable thresholds.                                                      | notice           |
| `migration-completed`                  | A kernel migration finished successfully (see [Migration / Upgrade](/reference/migration-upgrade)).          | info             |
| `migration-rollback`                   | A kernel migration rolled back.                                                                              | warning          |

The category enum is closed in v1. Adding a new category goes through the
`CONVENTIONS.md` §6 RFC.

## Signal record

```yaml
NotificationSignal:
  id: notification:01HM9N7XK4QY8RT2P5JZF6V3W9
  category: quota-near-limit
  spaceId: space:acme-prod
  organizationId: organization:acme
  severity: warning
  recipientActorIds:
    - actor:alice
    - actor:acme-billing
  payload:
    quotaDimension: deployments-per-hour
    threshold: 0.95
    observed: 0.962
    resetAt: 2026-05-05T08:00:00.000Z
  relatedAuditEventIds:
    - 01HM9N7XK4QY8RT2P5JZF6V3W7
  emittedAt: 2026-05-05T07:43:11.214Z
  acknowledgedAt: null
```

Field semantics:

| Field                  | Required | Notes                                                                                                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | yes      | `notification:<ulid>` form. Deterministic for idempotent triggers (see below). Immutable.                                                      |
| `category`             | yes      | Closed v1 enum.                                                                                                                                |
| `spaceId`              | no       | Owning Space when the signal is Space-scoped. Nullable for kernel-global signals (for example, `migration-completed` covering every Space).    |
| `organizationId`       | no       | Owning Organization when present; derived from `spaceId` or recipient set.                                                                     |
| `severity`             | yes      | Closed enum: `info`, `notice`, `warning`, `error`, `critical`. Matches the audit envelope severity scale.                                      |
| `recipientActorIds`    | yes      | List of Actor ids resolved at emit time. Empty list is rejected; if no recipient resolves, the kernel records a `severity: error` audit event. |
| `payload`              | yes      | Category-specific structured payload, shape-pinned per category. Unknown payload fields are rejected at emit time.                             |
| `relatedAuditEventIds` | yes      | One or more audit events that grounded the signal. Empty list rejected.                                                                        |
| `emittedAt`            | yes      | RFC 3339 UTC, millisecond precision.                                                                                                           |
| `acknowledgedAt`       | no       | Set when the operator's outer stack acknowledges the signal through the API below.                                                             |

## Recipient resolution

The kernel computes `recipientActorIds` at emit time from the identity model
(see [Actor / Organization Model](/reference/actor-organization-model)) and the
category-specific recipient rule. The rule is closed in v1:

| Category                               | Recipient rule                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `approval-pending`                     | Actors holding the approval-authority role on the Space's Organization.                                            |
| `approval-near-expiry`                 | Same as `approval-pending`.                                                                                        |
| `revoke-debt-operator-action-required` | Actors holding `space-admin` on the Space's Organization plus the Organization's `billingContactActorId`.          |
| `quota-near-limit`                     | Actors holding `space-admin` on the Space's Organization plus `billingContactActorId`.                             |
| `sla-breach-detected`                  | Actors holding `space-admin` on every affected Organization.                                                       |
| `incident-acknowledged`                | Actors holding any membership state `active` on the affected Organizations, plus `billingContactActorId`.          |
| `incident-resolved`                    | Same recipient set as the `incident-acknowledged` signal that grounded the same incident.                          |
| `space-trial-expiring`                 | `billingContactActorId` plus `org-owner` Actors of the Space's Organization.                                       |
| `api-key-expiring`                     | The Actor that owns the API key. If the owner is `service-account`, the Organization's `org-owner` Actors instead. |
| `migration-completed`                  | `org-owner` Actors of every Organization with at least one active Space.                                           |
| `migration-rollback`                   | Same recipient set as `migration-completed` for the same migration id.                                             |

The resolution uses the live identity view at emit time. A signal emitted just
before a Membership transitions to `removed` carries the prior
`recipientActorIds`; the kernel does not re-resolve after emission.

## Pull-only delivery integration

The kernel does not push to operator delivery systems. In the design-reserved
HTTP surface, operators pull the signal queue:

- `GET /api/internal/v1/notifications` — list signals with cursor pagination.
  Filters on `category`, `spaceId`, `organizationId`, `severity`, and time
  window. Cursor is opaque and stable across acknowledgement.
- `GET /api/internal/v1/notifications?since=<cursor>` — resume pull from the
  last seen cursor.
- `POST /api/internal/v1/notifications/:id/ack` — operator acknowledges a signal
  once delivery has been attempted. Sets `acknowledgedAt`. Acknowledgement is
  independent of delivery outcome; the kernel records the signal regardless.

The pull-only model:

- Removes any push credential from the kernel.
- Lets operators deploy a single delivery worker per region and scale
  horizontally with at-least-once consumer semantics.
- Keeps signals durable until the operator-tunable retention window closes;
  unacknowledged signals are retained longer than acknowledged signals, bounded
  by audit retention.

A webhook-style push mode is **out of scope for v1**. The kernel does not
initiate any outbound HTTP call for notification delivery.

## Idempotency

Signal `id` is deterministic per `(category, scope, trigger
fingerprint)` tuple.
The trigger fingerprint is category-specific:

- `approval-pending`, `approval-near-expiry`: `approvalId` plus the TTL
  milestone (`issue`, `50pct`, `90pct`).
- `revoke-debt-operator-action-required`: `revokeDebtId` plus the transition
  timestamp.
- `quota-near-limit`: `(quotaDimension, threshold, window-start)`.
- `sla-breach-detected`: the breach signal id.
- `incident-acknowledged`, `incident-resolved`: `(incidentId,
  toState)`.
- `space-trial-expiring`: `(spaceId, milestone)` where milestone is one of `7d`,
  `1d`, `1h`.
- `api-key-expiring`: `(apiKeyId, milestone)`.
- `migration-completed`, `migration-rollback`: `(migrationId,
  outcome)`.

Re-evaluating the same trigger produces the same `id`. The kernel deduplicates
at write time: an attempted second emit with an existing `id` is recorded as a
no-op and surfaces in audit as a `notification-emit-suppressed-duplicate`
envelope on the same record.

## Audit events

The v1 notification audit event taxonomy is closed and joins the
[Audit Events](/reference/audit-events) closed enum:

- `notification-emitted`
- `notification-acknowledged`

Each event carries the standard envelope plus a payload recording
`{notificationId, category, recipientActorIds, relatedAuditEventIds}`. The audit
chain links the notification record to the source events in
`relatedAuditEventIds`, so operators can replay the chain that grounded any
signal.

## Storage schema

NotificationSignal extends [Storage Schema](/reference/storage-schema) with one
record class:

| Record               | Indexed by                                                                                                 | Persistence                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `NotificationSignal` | `(id)`, `(category, emittedAt)`, `(spaceId, emittedAt)`, `(organizationId, emittedAt)`, `(acknowledgedAt)` | Kept under audit retention; acknowledged signals trim earlier than unacknowledged. |

Implementations may co-locate the signal store with the audit store but must
keep the indexed columns above.

## Scope boundary

The Takosumi kernel ships the signal record, the closed category enum, the
recipient resolution rule, the pull-only operator endpoints, the idempotency
rule, and the audit chain. Concrete email templates, Slack bot wiring, in-app
push channels, SMS and voice gateways, digest scheduling, locale-aware
rendering, unsubscribe and preference UI, and per-recipient delivery throttling
are **outside Takosumi's scope** and are implemented by the operator's outer
stack (for example, `takos-private/` or any other PaaS-provider front end). The
kernel exposes the signal and audit primitives that those outer surfaces compose
against.

## Related design notes

- `docs/design/operator-boundaries.md` — credential boundary that motivates the
  pull-only delivery model.
- `docs/design/policy-risk-approval-error-model.md` — approval and risk events
  grounding the approval-related categories.
- `docs/design/observation-drift-revokedebt-model.md` — RevokeDebt trigger
  grounding the `revoke-debt-operator-action-required` category.
