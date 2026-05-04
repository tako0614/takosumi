# RBAC Policy

> Stability: stable
> Audience: kernel-implementer, operator, integrator
> See also: [Actor / Organization Model](/reference/actor-organization-model),
> [API Key Management](/reference/api-key-management),
> [Auth Providers](/reference/auth-providers),
> [Kernel HTTP API](/reference/kernel-http-api),
> [WAL Stages](/reference/wal-stages),
> [Closed Enums](/reference/closed-enums),
> [Audit Events](/reference/audit-events),
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Tenant Export and Deletion](/reference/tenant-export-deletion),
> [Trial Spaces](/reference/trial-spaces),
> [Cost Attribution](/reference/cost-attribution),
> [Quota Tiers](/reference/quota-tiers),
> [SLA Breach Detection](/reference/sla-breach-detection),
> [Incident Model](/reference/incident-model),
> [Support Impersonation](/reference/support-impersonation),
> [Notification Emission](/reference/notification-emission),
> [Zone Selection](/reference/zone-selection),
> [Resource IDs](/reference/resource-ids)

This reference defines the v1 role-based access control surface the
Takosumi kernel enforces on every authenticated request: the closed
role enum, the permission matrix that maps roles to operation kinds,
the enforcement points along the apply pipeline, and the
RoleAssignment record that binds a role to a Membership.

The role enum and the enforcement contract are closed in v1. Operators
may not invent new role names or attach permissions outside the
matrix below.

## Closed role enum

```text
org-owner | org-admin | org-billing
space-admin | space-deployer | space-viewer
support-staff
```

Roles split on two axes: Organization-level roles bind to an
Organization, Space-level roles bind to a `(Space, Organization)`
tuple, and `support-staff` is operator-controlled and always bound
through impersonation.

| Role             | Axis              | Summary                                                                                                  |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `org-owner`      | Organization      | Full authority within the Organization, including ownership transfer and Member management.             |
| `org-admin`      | Organization      | Member management, role assignment up to `space-admin`, Space creation; cannot remove the last owner.    |
| `org-billing`    | Organization      | Read-only access plus billing-bound surfaces; no deploy or destroy authority.                            |
| `space-admin`    | Space             | Full authority within one Space: deploy, destroy, approval issue, share grant, role assignment in Space. |
| `space-deployer` | Space             | Submit manifests, run plan / apply, upload artifacts; cannot issue approvals or grant shares.            |
| `space-viewer`   | Space             | Read-only: status, plan inspection, artifact list. No mutating effect.                                   |
| `support-staff`  | Operator-tenancy  | Routed through support-impersonation. Not a Member. Covered separately.                                  |

The kernel rejects RoleAssignment writes that reference a name outside
this list. Adding a role, splitting a role, or merging roles requires
a `CONVENTIONS.md` §6 RFC. Operator-defined custom roles are
**out of scope** in v1; the operator may compose Custom UI labels
above these roles, but the kernel-side enforcement vocabulary remains
this seven-value enum.

## Permission matrix

The matrix maps each role to a permit / deny decision per kernel
operation kind. `permit` means the kernel enforcement point allows
the request; `deny` means the kernel returns `permission_denied`
(see [Closed Enums — DomainErrorCode](/reference/closed-enums#domainerrorcode)).
A role's authority is the union of permits granted at its axis.

| Operation kind                                    | org-owner | org-admin | org-billing | space-admin | space-deployer | space-viewer | support-staff |
| ------------------------------------------------- | --------- | --------- | ----------- | ----------- | -------------- | ------------ | ------------- |
| organization.read                                 | permit    | permit    | permit      | permit      | permit         | permit       | permit        |
| organization.update                               | permit    | permit    | deny        | deny        | deny           | deny         | deny          |
| organization.delete                               | permit    | deny      | deny        | deny        | deny           | deny         | deny          |
| organization.member.invite                        | permit    | permit    | deny        | deny        | deny           | deny         | deny          |
| organization.member.remove                        | permit    | permit    | deny        | deny        | deny           | deny         | deny          |
| organization.role.assign (org-axis)               | permit    | permit\*  | deny        | deny        | deny           | deny         | deny          |
| organization.billing.read                         | permit    | permit    | permit      | deny        | deny           | deny         | deny          |
| organization.billing.update                       | permit    | deny      | permit      | deny        | deny           | deny         | deny          |
| space.create                                      | permit    | permit    | deny        | deny        | deny           | deny         | deny          |
| space.read                                        | permit    | permit    | permit      | permit      | permit         | permit       | permit        |
| space.update                                      | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| space.destroy                                     | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| space.role.assign (space-axis)                    | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| deployment.plan                                   | permit    | permit    | deny        | permit      | permit         | deny         | deny          |
| deployment.apply                                  | permit    | permit    | deny        | permit      | permit         | deny         | deny          |
| deployment.destroy                                | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| approval.issue                                    | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| approval.deny                                     | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| artifact.upload                                   | permit    | permit    | deny        | permit      | permit         | deny         | deny          |
| artifact.list                                     | permit    | permit    | permit      | permit      | permit         | permit       | permit        |
| artifact.delete                                   | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| share.grant                                       | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| share.revoke                                      | permit    | permit    | deny        | permit      | deny           | deny         | deny          |
| status.read                                       | permit    | permit    | permit      | permit      | permit         | permit       | permit        |
| audit.read                                        | permit    | permit    | permit      | permit      | deny           | deny         | permit        |
| support.impersonate                               | deny      | deny      | deny        | deny        | deny           | deny         | permit        |

\* `org-admin` may assign `org-billing`, `space-admin`,
`space-deployer`, `space-viewer`. `org-admin` may **not** assign
`org-owner` or `org-admin`; only an existing `org-owner` may.

### v1 PaaS-provider primitive operation rows

The following rows extend the matrix above with the operation kinds
introduced by the v1 PaaS-provider primitives (tenant lifecycle,
quota and SLA enforcement, incident response, support impersonation
grant and session lifecycle, identity issuance). The closure rule
holds: `deny` is a hard deny, `policy-gated` is `permit` only when
the operator-supplied policy bundle accepts the request, and
`with-approval` is `permit` only when an `approval.issue`-bearing
Actor has produced an `approved` approval covering the operation.

`operator-only` rows are reachable only through the kernel's
internal HMAC surface (see
[Kernel HTTP API — Authentication](/reference/kernel-http-api#authentication));
the matrix records `deny` for every customer-facing role and the
operator-only marker carries the actual decision.

| Operation kind                              | org-owner    | org-admin    | org-billing | space-admin    | space-deployer | space-viewer | support-staff | Operator-only |
| ------------------------------------------- | ------------ | ------------ | ----------- | -------------- | -------------- | ------------ | ------------- | ------------- |
| space-provisioning                          | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| space-export-request                        | permit       | permit       | deny        | permit         | deny           | deny         | deny          | no            |
| space-delete-request                        | permit       | permit       | deny        | with-approval  | deny           | deny         | deny          | no            |
| space-delete-confirm                        | with-approval| deny         | deny        | deny           | deny           | deny         | deny          | no            |
| trial-extend                                | permit       | permit       | deny        | deny           | deny           | deny         | deny          | no            |
| trial-convert                               | permit       | deny         | deny        | deny           | deny           | deny         | deny          | no            |
| cost-attribution-read                       | permit       | permit       | permit      | permit         | deny           | deny         | permit        | no            |
| cost-attribution-update                     | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| billing-export                              | permit       | permit       | permit      | deny           | deny           | deny         | deny          | no            |
| quota-tier-read                             | permit       | permit       | permit      | permit         | permit         | permit       | permit        | no            |
| quota-tier-register                         | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| quota-tier-assign                           | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| sla-threshold-register                      | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| incident-read                               | permit       | permit       | permit      | permit         | permit         | permit       | permit        | no            |
| incident-acknowledge                        | permit       | permit       | deny        | permit         | deny           | deny         | deny          | no            |
| incident-state-change                       | permit       | permit       | deny        | permit         | deny           | deny         | permit        | no            |
| incident-postmortem-publish                 | permit       | permit       | deny        | permit         | deny           | deny         | deny          | no            |
| support-impersonation-request               | deny         | deny         | deny        | deny           | deny           | deny         | permit        | no            |
| support-impersonation-approve               | deny         | deny         | deny        | permit         | deny           | deny         | deny          | no            |
| support-impersonation-revoke                | deny         | deny         | deny        | permit         | deny           | deny         | permit\*\*    | no            |
| support-impersonation-session-open          | deny         | deny         | deny        | deny           | deny           | deny         | permit\*\*\*  | no            |
| support-impersonation-session-end           | deny         | deny         | deny        | permit         | deny           | deny         | permit\*\*\*  | yes           |
| api-key-issue (deploy-token)                | permit       | permit       | deny        | permit         | permit         | deny         | deny          | no            |
| api-key-issue (read-token)                  | permit       | permit       | permit      | permit         | permit         | permit       | deny          | no            |
| api-key-issue (admin-token)                 | permit       | permit       | deny        | permit         | deny           | deny         | deny          | no            |
| api-key-rotate                              | permit       | permit       | policy-gated| permit         | policy-gated   | deny         | deny          | no            |
| api-key-revoke                              | permit       | permit       | policy-gated| permit         | policy-gated   | deny         | deny          | no            |
| auth-provider-register                      | deny         | deny         | deny        | deny           | deny           | deny         | deny          | yes           |
| role-assign                                 | permit       | permit\*     | deny        | permit (space) | deny           | deny         | deny          | no            |
| role-revoke                                 | permit       | permit\*     | deny        | permit (space) | deny           | deny         | deny          | no            |
| membership-invite                           | permit       | permit       | deny        | deny           | deny           | deny         | deny          | no            |
| membership-accept                           | deny         | deny         | deny        | deny           | deny           | deny         | deny          | no\*\*\*\*    |
| membership-remove                           | permit       | permit       | deny        | deny           | deny           | deny         | deny          | no            |

\*\* `support-impersonation-revoke` is `permit` for `support-staff`
only when the requesting Actor is the same `supportActorId` recorded
on the grant. Foreign support-staff Actors return `permission_denied`.

\*\*\* `support-impersonation-session-open` and
`support-impersonation-session-end` are `permit` for `support-staff`
only when the Actor holds an active grant in the `approved` state on
the targeted Space. The kernel evaluates the grant store in addition
to the matrix row.

\*\*\*\* `membership-accept` is initiated by the invitee through the
invite envelope; the kernel verifies the invitee Actor matches the
invite payload rather than evaluating the matrix. The row is recorded
as `deny` for every named role to keep the closed enum honest;
acceptance flows the invite-envelope path, not the operation matrix.

#### org-billing read-billing-only contract

`org-billing` is **read-billing-only** in v1. The rows above pin the
contract:

- `cost-attribution-read`, `billing-export`, `quota-tier-read`,
  `incident-read`, `audit.read`, `organization.billing.read`,
  `organization.read`, `space.read`, `status.read`,
  `artifact.list` — `permit`.
- `api-key-issue (deploy-token)`, `api-key-issue (admin-token)`,
  `deployment.plan`, `deployment.apply`, `deployment.destroy`,
  `artifact.upload`, `artifact.delete`, `cost-attribution-update`,
  `quota-tier-register`, `quota-tier-assign`, `sla-threshold-register`,
  `auth-provider-register` — `deny`.
- `api-key-rotate` and `api-key-revoke` — `policy-gated`. The kernel
  permits an `org-billing` Actor to rotate or revoke an `api-key`
  whose scope is bound to a `read-token` they themselves issued,
  only when the operator policy bundle marks
  `billing-actor-self-rotate` accepting. Other key types return
  `permission_denied` even with a policy match.

This pins the boundary recorded by
[API Key Management](/reference/api-key-management): an
`org-billing` Actor is rejected by the
`api-key-issue (deploy-token)` row and may not mint deploy
credentials.

#### Closed enum extension note

The matrix expansion above does not relax the seven-value role enum.
Adding a new operation kind that is not on the list, splitting a row,
or merging rows requires the `CONVENTIONS.md` §6 RFC. The closure
rule for the role enum and for the matrix shape itself remains
unchanged.

`support-staff` is included for completeness; the impersonation flow
gates `support-staff` decisions through additional triggers covered
separately. Outside an impersonation session, a `support-staff` Actor
holds only `organization.read`, `space.read`, `status.read`,
`audit.read`, `artifact.list`, and the four
`support-impersonation-request` / `support-impersonation-approve` /
`support-impersonation-session-open` /
`support-impersonation-session-end` operations subject to the grant
and session preconditions in the rows above.

The matrix is closed: a row that lists `deny` for a role is a hard
deny, not an "ask the operator" gap. New operation kinds (or new
rows) require the `CONVENTIONS.md` §6 RFC.

## Enforcement points

Authorization runs at three points along the apply pipeline.

1. **Request ingress.** After the auth provider resolves the bearer,
   HMAC, or mTLS credential to an `actor:<id>` (see
   [Auth Providers](/reference/auth-providers)), the router fetches
   the Actor's Memberships and active RoleAssignments. The role set
   is cached for the request lifetime. If the role set does not
   include any role that permits the matched operation, the kernel
   returns `permission_denied` before any state mutation.
2. **WAL `prepare` stage.** The apply pipeline re-validates
   permission against the resolved manifest. If the resolved
   `OperationPlan` introduces an operation kind the requesting Actor
   does not hold (for example, an `apply` that includes
   `share.grant`), the prepare stage records `permission_denied` on
   the WAL entry. The apply does not advance to `pre-commit`. See
   [WAL Stages](/reference/wal-stages) for the broader stage
   contract.
3. **Approval consumption.** Before the kernel consumes an
   `approved` approval, it verifies the issuing Actor still holds the
   `approval.issue` permission. A revoked role between issue and
   consume invalidates the approval (see
   [Approval Invalidation Triggers](/reference/approval-invalidation)
   under the Space-context change family) and returns
   `permission_denied`.

Revocation is read-after-write consistent: removing a role yields a
`permission_denied` on every subsequent request, even within the
same client session.

### Cross-Space requests

Requests that touch more than one Space (for example, a
`SpaceExportShare` grant from Space A to Space B) require the
requesting Actor to hold a permitting role in **both** Spaces. The
kernel evaluates each Space's matrix row independently and returns
`permission_denied` on the first miss. The denial event records the
denying Space id so operators can pinpoint the missing role without
exposing whether the other Space accepted.

### Operator-axis carve-outs

Two operations bypass the matrix above and run only through the
internal HMAC surface:

- The four support-impersonation operations
  (`support-impersonation-request`,
  `support-impersonation-approve`,
  `support-impersonation-session-open`,
  `support-impersonation-session-end`) require both the matrix
  authority above and the grant or session record state recorded by
  [Support Impersonation](/reference/support-impersonation). The
  kernel will not honour a `support-staff` role on
  `support-impersonation-session-open` without an active
  `approved` grant on the targeted Space.
- `organization.delete` is permitted to `org-owner` per the matrix,
  but the kernel additionally verifies that every Space owned by the
  Organization is destroyed or transferred (see
  [Actor / Organization Model](/reference/actor-organization-model)).
  A pending Space rejects the call as `failed_precondition` even when
  the role check passes.

## RoleAssignment record

A RoleAssignment binds a role to a Membership.

```yaml
RoleAssignment:
  id: role-assignment:01HM9N7XK4QY8RT2P5JZF6V3W9
  membershipId: membership:01HM9N7XK4QY8RT2P5JZF6V3W9
  organizationId: organization:acme
  spaceId: space:acme-prod        # required for space-axis roles
  role: space-deployer
  assignedAt: 2026-04-12T07:43:11.214Z
  assignedByActorId: actor:acme-root
  expiresAt: null
```

Field semantics:

| Field               | Required                     | Notes                                                                                                            |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                | yes                          | `role-assignment:<ulid>` form. Kernel-minted.                                                                    |
| `membershipId`      | yes                          | Bound Membership; immutable.                                                                                     |
| `organizationId`    | yes                          | Redundant with the Membership's Organization for fast indexing.                                                  |
| `spaceId`           | conditional                  | Required when `role` is a Space-axis role (`space-admin` / `space-deployer` / `space-viewer`); rejected otherwise. |
| `role`              | yes                          | One of the seven closed enum values.                                                                             |
| `assignedAt`        | yes                          | Assignment time.                                                                                                 |
| `assignedByActorId` | yes                          | Actor that issued the assignment. Must hold an assigning role at assign time.                                    |
| `expiresAt`         | no                           | Optional auto-revoke instant. The kernel removes the assignment at the boundary and emits an audit event.        |

The kernel persists assignments under
[Storage Schema](/reference/storage-schema) and indexes them by
`(membershipId)`, `(organizationId, role)`, and `(spaceId, role)`.
Assignment writes go through the operator surface and the
self-service surface gated by the matrix above.

## Audit coverage

RoleAssignment lifecycle adds three closed audit event types under the
"Identity" group of [Audit Events](/reference/audit-events):

```text
role-assignment-created
role-assignment-revoked
role-assignment-expired
```

Each event records `{organizationId, spaceId, membershipId, role,
assignedByActorId}` and follows the standard envelope and chain
rules.

## Scope boundary

The Takosumi kernel enforces this seven-value role enum and the
permission matrix above; that is the entire scope of v1 RBAC. The
kernel does **not** ship customer dashboard layouts, customer-facing
"team" or "project" labelling, custom permission naming, free-text
permission descriptions, branded role icons, or any UX renaming of the
closed role names. Operators that want a richer surface for their
end users compose the kernel matrix from outside (for example, in
`takos-private/`) and surface their own labels above it. Custom-role
support is reserved for a future RFC and is **not** present in v1.

## Related design notes

- docs/design/policy-risk-approval-error-model.md
- docs/design/space-model.md
- docs/design/operation-plan-write-ahead-journal-model.md
