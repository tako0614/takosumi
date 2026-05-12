# Support Impersonation

> Stability: stable Audience: operator, kernel-implementer See also:
> [Actor / Organization Model](/reference/actor-organization-model),
> [Audit Events](/reference/audit-events),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Storage Schema](/reference/storage-schema),
> [Incident Model](/reference/incident-model),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 authentication model for support-staff Actors that
read or write into a customer Space on behalf of the operator's support
function. It pins the support-staff actor type, the impersonation grant and
session records, the approval flow that lets a customer admin authorize the
grant, the read-only and read-write scope rules, the session TTL bounds, the
audit primitives, and the operator-only API surface. Concrete support
dashboards, ticket integration, screen-sharing tools, and customer-facing
approval UI are out of scope for the kernel.

## Support-staff actor

The `support-staff` actor type is part of the closed v1 actor type enum (see
[Actor / Organization Model](/reference/actor-organization-model#actor-types)).
Its identity form is:

```text
actor:support-staff/<id>
```

Properties:

- Auth source is OIDC against the operator's support tenant or an
  operator-issued bearer token bound to a support-tenant subject.
- A support-staff Actor never holds direct Space membership. It does not appear
  in any Membership record. RBAC role assignment is rejected for support-staff
  Actors.
- Authorization to read or write a Space is mediated entirely through the
  impersonation grant and session records below.
- A support-staff Actor lifecycle is operator-controlled: creating, suspending,
  and deleting them lives on the operator side.

The kernel rejects a public-deploy-bearer or runtime-agent enrollment that would
mint a support-staff Actor. The minting path is operator internal-control-plane
only.

## Impersonation grant

An impersonation grant is the authorization artifact that allows a support-staff
Actor to open sessions against a Space.

```yaml
SupportImpersonationGrant:
  id: support-grant:01HM9N7XK4QY8RT2P5JZF6V3W9
  supportActorId: actor:support-staff/jane
  spaceId: space:acme-prod
  scope: read-only # or read-write
  reason: "ticket ACME-1234: deploy stuck in failed-apply"
  ticketRef: "acme-tickets#1234" # operator-supplied opaque reference, optional
  state: requested # closed enum below
  requestedAt: 2026-05-05T07:43:11.214Z
  approvedAt: null
  rejectedAt: null
  expiresAt: 2026-05-06T07:43:11.214Z
  approvedByActorId: null
  rejectedByActorId: null
```

Field semantics:

| Field               | Required | Notes                                                                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                | yes      | `support-grant:<ulid>` form. Kernel-minted at create. Immutable.                                                    |
| `supportActorId`    | yes      | Must reference an Actor whose type is `support-staff`. Immutable.                                                   |
| `spaceId`           | yes      | Single Space scope. v1 grants are not multi-Space; cross-Space support work creates one grant per Space. Immutable. |
| `scope`             | yes      | Closed enum: `read-only`, `read-write`. Default at create is `read-only`. Immutable for the grant.                  |
| `reason`            | yes      | Mandatory free-form rationale recorded into the audit chain. Minimum length enforced by kernel.                     |
| `ticketRef`         | no       | Operator-supplied opaque reference for cross-system correlation.                                                    |
| `state`             | yes      | Closed enum (see lifecycle).                                                                                        |
| `requestedAt`       | yes      | RFC 3339 UTC, millisecond precision.                                                                                |
| `approvedAt`        | no       | Set when `state` becomes `approved`.                                                                                |
| `rejectedAt`        | no       | Set when `state` becomes `rejected`.                                                                                |
| `expiresAt`         | yes      | TTL ceiling for the grant. Bounded by operator-tunable max (default 1h, 24h max).                                   |
| `approvedByActorId` | no       | Customer admin Actor that approved. Required at approve time.                                                       |
| `rejectedByActorId` | no       | Customer admin Actor or operator that rejected.                                                                     |

### Grant lifecycle

```text
requested --(customer-admin-approves)--> approved --(expires | revoked)--> terminated
   |                                          |
   |                                          `--(customer-admin-revokes)--> revoked
   `--(customer-admin-rejects | operator-cancels)--> rejected
```

Closed `state` enum: `requested`, `approved`, `rejected`, `revoked`, `expired`.

- `requested`: grant created by the operator on behalf of a support-staff Actor.
  The grant is not yet usable.
- `approved`: a customer admin (member with `space-admin` role on the target
  Space's Organization) accepted the grant. Sessions can be opened up to
  `expiresAt`.
- `rejected`: customer admin denied or the operator cancelled before approval.
- `revoked`: customer admin or operator terminated an approved grant before TTL.
- `expired`: kernel auto-terminated at `expiresAt`.

Terminal states: `rejected`, `revoked`, `expired`. The kernel rejects mutating a
terminal grant back to an active state. A new grant must be minted.

### Approval flow

1. Operator issues `POST /api/internal/v1/support/impersonations` with
   `supportActorId`, `spaceId`, `scope`, `reason`, and optional `ticketRef`.
   Grant enters `requested`.
2. Customer admin sees the pending grant on the customer-self-service plane (a
   kernel-side query, not a UI) and either accepts or rejects.
3. Acceptance moves the grant to `approved` and records `approvedByActorId` and
   `approvedAt`. The kernel verifies the acting Actor holds `space-admin` on the
   target Space's Organization at approve time; the check uses the live RBAC
   view and rejects stale assignments.
4. Rejection moves the grant to `rejected` with `rejectedByActorId` and
   `rejectedAt`.

A `read-write` grant requires the customer admin's explicit consent at approval
time: the approval payload carries an explicit `acceptScope: "read-write"`
field. The kernel rejects a `read-write` grant if the approval payload only
carries `read-only`.

## Impersonation session

A session is the runtime token issued under an approved grant.

```yaml
SupportImpersonationSession:
  id: support-session:01HM9N7XK4QY8RT2P5JZF6V3WA
  grantId: support-grant:01HM9N7XK4QY8RT2P5JZF6V3W9
  supportActorId: actor:support-staff/jane
  spaceId: space:acme-prod
  scope: read-only
  startedAt: 2026-05-05T07:50:00.000Z
  endedAt: null
  expiresAt: 2026-05-05T08:50:00.000Z
  endReason: null
```

Field semantics:

| Field            | Required | Notes                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `id`             | yes      | `support-session:<ulid>` form. Kernel-minted. Immutable.                                               |
| `grantId`        | yes      | Owning grant. Immutable.                                                                               |
| `supportActorId` | yes      | Inherited from the grant. Immutable.                                                                   |
| `spaceId`        | yes      | Inherited from the grant. Immutable.                                                                   |
| `scope`          | yes      | Inherited from the grant; cannot be widened mid-session.                                               |
| `startedAt`      | yes      | RFC 3339 UTC, millisecond precision.                                                                   |
| `endedAt`        | no       | Set on session end.                                                                                    |
| `expiresAt`      | yes      | Session TTL. Default 1h, operator-tunable, 24h max. Cannot exceed the grant's `expiresAt`.             |
| `endReason`      | no       | Closed enum: `expired`, `support-ended`, `customer-revoked`, `operator-cancelled`, `grant-terminated`. |

Session rules:

- Default scope is `read-only`. A `read-only` session may invoke any Space-read
  endpoint authorized by the live RBAC view; write surfaces reject the session
  token.
- A `read-write` session requires the parent grant to be `read-write`. Every
  write action emits a `support-impersonation-write-action-recorded` audit event
  in addition to the action's own audit event.
- Session token is not exchangeable for any other Space's scope; a grant ending
  mid-session ends every session it owns.

## Rate limit and active-session caps

The kernel enforces caps to prevent over-broad impersonation:

- Per Space, a maximum number of concurrently `approved` grants
  (operator-tunable, default 3). Excess grant requests are rejected.
- Per Space, a maximum number of concurrently active sessions (operator-tunable,
  default 2). Excess session opens are rejected.
- Per support-staff Actor, a maximum number of concurrent active sessions across
  all Spaces (operator-tunable, default 5).

Cap exhaustion emits a `severity: warning` audit signal. Repeated cap exhaustion
within the operator-tunable window is itself a trigger family for the
[Incident Model](/reference/incident-model) auto-detection path: a sustained
burst of rejected grant requests or session opens auto-mints an incident under
the `support-impersonation-burst` family.

## Audit events

The v1 support-impersonation audit event taxonomy is closed and joins the
[Audit Events](/reference/audit-events) closed enum:

- `support-impersonation-requested`
- `support-impersonation-approved`
- `support-impersonation-rejected`
- `support-impersonation-revoked`
- `support-impersonation-expired`
- `support-impersonation-session-started`
- `support-impersonation-session-ended`
- `support-impersonation-write-action-recorded`

Each event carries the standard envelope plus a payload recording
`{grantId, sessionId, supportActorId, spaceId, scope, reason,
endReason}` where
applicable. The audit chain is permanent: terminal grants and sessions remain in
the audit store under the Space's compliance regime (see
[Audit Events](/reference/audit-events)). Customer admins read these events
through the same audit query the kernel exposes for any Space-scoped event.

## Operator-only endpoints

plane, gated by HMAC (see [Kernel HTTP API](/reference/kernel-http-api)):

- `POST /api/internal/v1/support/impersonations` — operator creates a grant.
  Body: `supportActorId`, `spaceId`, `scope`, `reason`, optional `ticketRef`,
  optional `expiresAt` override bounded by the operator max.
- `DELETE /api/internal/v1/support/impersonations/:id` — operator cancels or
  revokes. Sets `state` to `rejected` (if `requested`) or `revoked` (if
  `approved`).
- `GET /api/internal/v1/support/impersonations` — list with filters on `state`,
  `spaceId`, `supportActorId`, time window.

A customer-self-service plane carries the approval and revoke endpoints for the
customer admin:

- `POST /v1/impersonations/:id/accept` — customer admin approves. Body carries
  `acceptScope` to confirm the requested scope.
- `POST /v1/impersonations/:id/reject` — customer admin rejects.
- `DELETE /v1/impersonations/:id` — customer admin revokes an approved grant
  (terminates every session it owns).

The customer-self-service plane uses the same RBAC enforcement as other
Space-admin operations. The kernel rejects any of the above from an Actor that
does not hold `space-admin` on the target Organization at the moment of the
call.

## Storage schema

Support impersonation extends [Storage Schema](/reference/storage-schema) with
two record classes:

| Record                        | Indexed by                                                                 | Persistence                              |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| `SupportImpersonationGrant`   | `(id)`, `(spaceId, state)`, `(supportActorId, state)`, `(expiresAt)`       | Kept indefinitely under audit retention. |
| `SupportImpersonationSession` | `(id)`, `(grantId)`, `(spaceId, startedAt)`, `(supportActorId, startedAt)` | Kept indefinitely under audit retention. |

## Scope boundary

The Takosumi kernel ships the support-staff actor type, the grant and session
records, the approval flow, the scope and TTL enforcement, the rate limits, the
audit chain, and the operator and self-service endpoints listed above. Customer
admin notification UI, support-staff dashboard, ticket-tracker integration,
screen-sharing or remote-control tooling, support-tenant identity provisioning,
and read-only redacted-view rendering are **outside Takosumi's scope** and are
implemented by the operator's outer stack (for example, `takos-private/` or any
other PaaS-provider front end). The kernel exposes the auth model and audit
primitives that those outer surfaces compose against.

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — support-staff actor as
  a separate trust boundary from human and service-account Actors.
- `docs/reference/architecture/policy-risk-approval-error-model.md` — approval
  semantics referenced by the read-write consent rule.
- `docs/reference/architecture/space-model.md` — Space-admin role binding
  referenced by the customer-self-service approval flow.
