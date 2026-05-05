# Actor / Organization Model

> Stability: stable Audience: operator, integrator, kernel-implementer See also:
> [Resource IDs](/reference/resource-ids),
> [Storage Schema](/reference/storage-schema),
> [RBAC Policy](/reference/rbac-policy),
> [API Key Management](/reference/api-key-management),
> [Auth Providers](/reference/auth-providers),
> [Audit Events](/reference/audit-events)

This reference defines the v1 identity primitives the Takosumi kernel persists
for PaaS-provider deployments: the **Actor** record (every principal that
authenticates to the kernel), the **Organization** record (a tenancy boundary
that owns one or more Spaces), and the **Membership** record (the relation
between an Actor and an Organization). It also pins the Space-to-Organization
ownership rule that v1 enforces, the wire shape of each record, and the operator
operations that mutate them.

The kernel ships these primitives as a closed model. Operators may not add new
actor types, organization types, or membership states without a `CONVENTIONS.md`
§6 RFC.

::: info Current HTTP status The organization and membership endpoints in this
reference are a spec / service contract. The current kernel HTTP router does not
mount `/api/internal/v1/organizations` or public membership self-service routes;
see [Kernel HTTP API](/reference/kernel-http-api) for current mounted routes.
:::

## Actor

An Actor is the kernel's view of a principal that authenticates to a public,
internal, or runtime-agent surface. Actors are minted once and never reissued: a
token rotation does not change the Actor id, and a provider switch (an Actor
moving from `bearer-token` to `oidc`) mints a new Actor.

### Identity

```text
actor:<id>
```

The id grammar follows
[Resource IDs — kebab-case name](/reference/resource-ids#kebab-case-name) for
operator-controlled actors and
[Resource IDs — ULID](/reference/resource-ids#ulid) for kernel-minted actors.
The kind prefix is closed and never aliased.

### Actor types

The actor type enum is closed in v1:

```text
human | service-account | runtime-agent | support-staff
```

| Type              | Auth source                                                                   | Persistence semantics                                                                        |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `human`           | OIDC id_token, or operator-issued bearer token bound to a human-owned id.     | Operator-created on Organization signup; lifecycle bound to Membership.                      |
| `service-account` | Long-lived bearer token issued through the API key surface.                   | Operator- or owner-created within an Organization; can hold deploy / read / admin scopes.    |
| `runtime-agent`   | mTLS or runtime-agent enrollment token verified at agent boot.                | Kernel-minted at first enrollment; one Actor per agent process identity.                     |
| `support-staff`   | OIDC id_token from the operator's support tenant, plus support-impersonation. | Operator-controlled; never holds direct Space membership, only support-impersonation grants. |

The auth source for each Actor is recorded on creation and is immutable for the
lifetime of that Actor. Auth provider mechanics live in
[Auth Providers](/reference/auth-providers); the support-staff impersonation
flow is out of scope for this page.

## Organization

An Organization is the tenancy unit that owns one or more Spaces. The kernel
scopes billing, audit, and RBAC role assignments to an Organization;
cross-Organization references go through SpaceExportShare (see
[Space Export Share](/reference/space-export-share)) and never through a direct
Organization-to-Organization handle.

### Identity

```text
organization:<id>
```

The suffix uses the kebab-case name grammar. The id is immutable; an
Organization rename is modeled as `create new + transfer Spaces +
delete old`.

### Organization record

```yaml
Organization:
  id: organization:acme
  displayName: "Acme, Inc."
  billingContactActorId: actor:acme-billing
  complianceRegime: default # or pci-dss | hipaa | gdpr
  createdAt: 2026-04-12T07:43:11.214Z
  ownerActorIds:
    - actor:acme-root
  status: active # or suspended | deleting
```

Field semantics:

| Field                   | Required | Notes                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                    | yes      | `organization:<id>` form. Immutable.                                                                           |
| `displayName`           | yes      | Operator-controlled label; not used for identity matching.                                                     |
| `billingContactActorId` | yes      | Single Actor that receives billing-bound notifications. Must hold `org-billing` or `org-owner`.                |
| `complianceRegime`      | yes      | Closed enum that pins audit retention; matches the regimes in [Audit Events](/reference/audit-events).         |
| `createdAt`             | yes      | RFC 3339 UTC, millisecond precision.                                                                           |
| `ownerActorIds`         | yes      | One or more Actor ids holding `org-owner`. The kernel rejects an empty list.                                   |
| `status`                | yes      | Closed enum: `active`, `suspended`, `deleting`. Operator-controlled; `deleting` blocks all member-side writes. |

`displayName`, `billingContactActorId`, `complianceRegime`, and `ownerActorIds`
are mutable in place. `id` and `createdAt` are not.

### Owner / member relation

- An Organization has at least one Actor in `ownerActorIds`. Removing the last
  owner is rejected; demotion requires another Actor first receive `org-owner`.
- Members are defined by Membership records (below), not by an inline list on
  the Organization. The Organization record only pins the owner set for fast
  lookup.
- Suspending an Organization (`status = suspended`) keeps Membership and Space
  ownership intact but rejects every write surface for member-side Actors.
  Owners and `support-staff` are not blocked, so remediation remains possible.

## Membership

A Membership record relates one Actor to one Organization. Membership is the
unit RBAC role assignments bind to (see [RBAC Policy](/reference/rbac-policy)).

### Membership record

```yaml
Membership:
  id: membership:01HM9N7XK4QY8RT2P5JZF6V3W9
  organizationId: organization:acme
  actorId: actor:alice
  state: active # or invited | left | removed
  joinedAt: 2026-04-12T07:43:11.214Z
  leftAt: null
  invitedByActorId: actor:acme-root
```

Field semantics:

| Field              | Required | Notes                                                                              |
| ------------------ | -------- | ---------------------------------------------------------------------------------- |
| `id`               | yes      | `membership:<ulid>` form. Kernel-minted at create.                                 |
| `organizationId`   | yes      | Owning Organization. Immutable.                                                    |
| `actorId`          | yes      | Member Actor. Immutable.                                                           |
| `state`            | yes      | Closed enum: `invited`, `active`, `left`, `removed`. See lifecycle below.          |
| `joinedAt`         | no       | Set when `state` first becomes `active`.                                           |
| `leftAt`           | no       | Set when `state` becomes `left` or `removed`.                                      |
| `invitedByActorId` | yes      | Actor that issued the invite; must hold `org-owner` or `org-admin` at invite time. |

The membership kind `membership:<ulid>` joins the closed v1 ID list as a
kernel-minted ULID; suffix grammar follows
[Resource IDs — ULID](/reference/resource-ids#ulid).

### Lifecycle

```text
invited --(accept)--> active --(actor-leaves)--> left
   |                       \--(owner-removes)--> removed
   `--(owner-revokes)----------------------------> removed
```

- `invited`: invite issued, not yet accepted. Cannot hold any role.
- `active`: accepted; eligible for role assignment.
- `left`: Actor-initiated termination. Audit-visible; role assignments drop
  atomically.
- `removed`: Owner- or admin-initiated termination. Audit-visible; role
  assignments drop atomically.

`left` and `removed` are terminal. Re-joining mints a new Membership (new id,
new `joinedAt`). The kernel rejects mutating a terminal Membership back to
`active`.

### Audit coverage

Every Membership state transition is an audit event:

```text
membership-invited
membership-accepted
membership-left
membership-removed
```

These four event types are added to the audit envelope under the "Identity"
group (see [Audit Events](/reference/audit-events)). Each event records
`{organizationId, actorId, membershipId,
invitedByActorId}` with the standard
envelope.

## Space ownership

In v1, every Space belongs to exactly one Organization.

- A Space is created with an `organizationId`. The field is required; the kernel
  rejects manifest submission against a Space whose Organization is `suspended`
  or `deleting`.
- A Space cannot move between Organizations through a single API call. Transfer
  is modeled as `create new Space in target Organization` +
  `SpaceExportShare or replicate manifest` + `destroy old Space`. A future
  direct transfer would land through a `CONVENTIONS.md` §6 RFC.
- Deleting an Organization requires every owned Space to be either destroyed or
  transferred (via the staged process above) first. The kernel rejects
  `DELETE /api/internal/v1/organizations/:id` while any Space references it.

The Space record adds an `organizationId` field referencing `organization:<id>`;
persistence and indexing extend [Storage Schema](/reference/storage-schema)
without changing the existing Space fields.

## Storage schema

Identity primitives extend [Storage Schema](/reference/storage-schema) with
three record classes:

| Record         | Indexed by                              | Persistence                                                                              |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Actor`        | `(id)`, `(authProviderId, externalSub)` | Kept while any Membership or Space ownership references the Actor; plus audit retention. |
| `Organization` | `(id)`, `(status)`                      | Kept while `status` is not `deleting` past retention; plus audit retention.              |
| `Membership`   | `(organizationId, state)`, `(actorId)`  | Kept indefinitely for terminal states (`left` / `removed`) under audit retention.        |

Implementations may co-locate these records with the existing tenant tables but
may not drop the indexed columns above.

## Operator-only operations

The following spec-reserved operations are operator-only and run through the
internal control plane (`/api/internal/v1/*`), gated by HMAC:

- `POST /api/internal/v1/organizations` — create.
- `PATCH /api/internal/v1/organizations/:id` — update mutable fields.
- `DELETE /api/internal/v1/organizations/:id` — mark `deleting`.
- `POST /api/internal/v1/organizations/:id/transfer-space` — staged Space
  transfer scaffold (rejects until both source and target are active).

Membership invite, accept, leave, and remove also surface on the public
actor-self-service plane for `org-owner` / `org-admin` Actors. RBAC enforcement
for these endpoints lives in [RBAC Policy](/reference/rbac-policy).

## Scope boundary

The Takosumi kernel ships the identity model, the records, the wire shape, and
the operator and self-service endpoints listed above. Customer-facing signup
forms, Terms-of-Service acceptance, billing contact validation against external
billing systems, anti-abuse heuristics, organization branding, and
end-user-facing dashboards are **outside Takosumi's scope** and are implemented
by the operator's outer stack (for example, `takos-private/` or any other
PaaS-provider front end). The kernel exposes the storage and enforcement
primitives that those outer surfaces compose against.

## Related architecture notes

- docs/reference/architecture/space-model.md
- docs/reference/architecture/policy-risk-approval-error-model.md
- docs/reference/architecture/snapshot-model.md
