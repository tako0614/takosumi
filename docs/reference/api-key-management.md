# API Key Management

> Stability: stable
> Audience: operator, integrator, kernel-implementer
> See also: [Actor / Organization Model](/reference/actor-organization-model),
> [RBAC Policy](/reference/rbac-policy),
> [Auth Providers](/reference/auth-providers),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Audit Events](/reference/audit-events),
> [Env Vars](/reference/env-vars)

This reference defines the v1 API key surface customers and operators
use to authenticate against the Takosumi kernel: the closed key-type
enum, the issue / rotate / revoke endpoints, the request and response
shapes, the storage rule (hash-only), the scope axes, and the audit
events emitted across the key lifecycle.

API keys are the canonical bearer credential the kernel accepts for
Actors that authenticate over the `bearer-token` provider. Other
provider types (OIDC id_token, mTLS, runtime-agent enrollment) flow
through their own primitives and do not produce API keys.

## Closed key type enum

```text
deploy-token | read-token | admin-token | support-token
```

| Type            | Capability summary                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `deploy-token`  | `deployment.plan`, `deployment.apply`, `artifact.upload`, `artifact.list`, `status.read`. No `destroy`.        |
| `read-token`    | `status.read`, `artifact.list`, `space.read`, `organization.read`. No mutating effects.                       |
| `admin-token`   | The full set of permissions the holding Actor possesses through Membership and RoleAssignment.                |
| `support-token` | Issued only to `support-staff` Actors. Bound to an active impersonation session; covered separately.          |

Adding a new key type requires the `CONVENTIONS.md` §6 RFC. The four
values above are the entire v1 enum.

The effective permission set of any presented key is the
**intersection** of (a) the key type's capability cap above and
(b) the issuing Actor's roles at the moment of request. Demoting an
Actor demotes every key it owns, regardless of when the key was
minted.

## Issue

### Operator-callable

```text
POST /api/internal/v1/api-keys
```

Authenticated via the kernel's internal HMAC (see
[Kernel HTTP API — Authentication](/reference/kernel-http-api#authentication)).

```ts
interface ApiKeyIssueRequest {
  readonly actorId: string;            // actor:<id>
  readonly kind: "deploy-token" | "read-token" | "admin-token";
  readonly scope: ApiKeyScope;
  readonly expiresAt?: string;         // RFC 3339 UTC
  readonly note?: string;              // operator-facing label, max 240 chars
}
```

### Actor self-service

```text
POST /v1/api-keys
```

Authenticated via an existing bearer token. The kernel rejects the
request unless the requesting Actor holds a role that permits issuing
the requested kind for the requested scope:

- `deploy-token`: requires `space-deployer` or higher in the scope's
  Space.
- `read-token`: requires `space-viewer` or higher in the scope's
  Space, or any Organization-level role.
- `admin-token`: requires `space-admin` (Space-scoped) or `org-admin`
  / `org-owner` (Organization-scoped) per the matrix in
  [RBAC Policy](/reference/rbac-policy).

Both endpoints accept the same body and return the same response.

### Response

```ts
interface ApiKeyIssueResponse {
  readonly keyId: string;              // api-key:<ulid>
  readonly plaintextToken: string;     // returned exactly once
  readonly kind: ApiKeyKind;
  readonly scope: ApiKeyScope;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}
```

`plaintextToken` is returned **once**. Subsequent reads of the API key
record return only the `keyId`, `kind`, `scope`, and `issuedAt /
expiresAt` metadata. The plaintext is not retrievable from the
kernel.

## Rotate

```text
POST /v1/api-keys/:id/rotate
POST /api/internal/v1/api-keys/:id/rotate
```

Rotation produces a new plaintext while keeping the same `keyId`,
`kind`, and `scope`. The operator-facing `note` and `expiresAt` are
preserved unless overridden in the request body.

```ts
interface ApiKeyRotateRequest {
  readonly graceWindowSeconds?: number; // default: TAKOSUMI_API_KEY_ROTATION_GRACE_SEC
  readonly expiresAt?: string;
}
```

During the grace window, both the prior and the new plaintext verify
successfully. The default grace window is operator-controlled
(`TAKOSUMI_API_KEY_ROTATION_GRACE_SEC`, default 24 hours). At grace
expiry the prior plaintext becomes invalid and a `api-key-rotated`
audit event records the boundary.

The grace window **never** survives a `revoke`: revocation cuts both
plaintexts simultaneously.

## Revoke

```text
DELETE /v1/api-keys/:id
DELETE /api/internal/v1/api-keys/:id
```

Revocation is immediate. The next request that presents either the
current or a grace-window plaintext returns `unauthenticated`. The
record is retained for the audit retention window
(see [Audit Events](/reference/audit-events)) so investigators can
trace usage; the plaintexts are never recoverable.

## Scope

```ts
interface ApiKeyScope {
  readonly organizationId: string;     // organization:<id>
  readonly spaceId?: string;           // space:<id>; absent => org-wide
  readonly operationKinds?: readonly string[]; // intersect with kind cap
  readonly ipAllowlist?: readonly string[];    // CIDR strings
}
```

- `organizationId` is required.
- `spaceId` binds the key to a single Space. Omitting it makes the
  key Organization-wide; the kernel still intersects with the
  Actor's Membership. Cross-Organization keys are rejected.
- `operationKinds`, when present, narrows the kind cap further. The
  effective set is `kindCap ∩ operationKinds ∩ actorRoles`.
- `ipAllowlist`, when present, restricts the key to source IPs that
  match at least one CIDR. Mismatch returns `unauthenticated`.

The kernel rejects scopes that reference Spaces the issuing Actor
cannot see, scopes whose `operationKinds` includes a value outside
the matched kind's cap, and scopes whose `ipAllowlist` contains a
malformed CIDR.

## Storage

The kernel persists only the **hash** of each plaintext.

| Field                | Notes                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                 | `api-key:<ulid>` form. Kernel-minted.                                                                          |
| `actorId`            | Owning Actor.                                                                                                  |
| `kind`               | One of the closed enum values above.                                                                           |
| `scope`              | Scope object as issued.                                                                                        |
| `tokenHash`          | argon2id digest of the plaintext.                                                                              |
| `priorTokenHash`     | argon2id digest of the prior plaintext during a rotation grace window; null otherwise.                         |
| `graceExpiresAt`     | Timestamp at which `priorTokenHash` becomes invalid.                                                           |
| `issuedAt`           | Issue time.                                                                                                    |
| `expiresAt`          | Optional auto-expiry instant.                                                                                  |
| `revokedAt`          | Set on revoke; the record is retained for audit.                                                               |
| `lastUsedAt`         | Last successful verification time. Best-effort; not transactional.                                             |

The argon2id parameters (`memory`, `iterations`, `parallelism`) are
operator-tunable through the kernel's secret-store config and are not
embedded in plaintext or hash. The kernel rejects an audit write or
state dump whose canonical bytes contain a substring matching the
active hash redaction set, the same rule used for secret partition
material (see [Audit Events — Redaction rule](/reference/audit-events#redaction-rule)).

Plaintext API keys never appear in audit events, status responses,
journal entries, or snapshots.

## Auto-expire

When `expiresAt` is set, a kernel sweep marks the key invalid at or
just after the boundary. The sweep emits `api-key-expired`. A
request presenting an expired plaintext returns `unauthenticated`.

`expiresAt` may be extended by an authorized actor through a rotate
call (with a new `expiresAt`), but never reduced below `now()` to
keep audit semantics simple.

## Audit events

API key lifecycle adds five closed audit event types under the
"Identity" group of [Audit Events](/reference/audit-events):

```text
api-key-issued
api-key-rotated
api-key-revoked
api-key-used
api-key-expired
```

`api-key-used` is best-effort: the kernel emits it on a sampled
basis (operator-tunable) to bound audit-store growth. The other
four events are emitted unconditionally for every transition.

## Scope boundary

The Takosumi kernel ships the issue / rotate / revoke endpoints, the
hash-only storage rule, the scope vocabulary, and the audit events
listed above; that is the entire v1 surface. End-user-facing
dashboards that list a customer's keys, copy-to-clipboard flows for
the one-time plaintext, "name your token" UX, billing-tied quota
display, or any branded key-management page is **outside Takosumi's
scope** and is implemented by the operator's outer stack
(for example, `takos-private/`). The kernel exposes the storage and
enforcement primitives that those outer surfaces compose against.

## Related design notes

- docs/design/policy-risk-approval-error-model.md
- docs/design/snapshot-model.md
- docs/design/space-model.md
