# Auth Providers

> Stability: stable Audience: kernel-implementer, operator, integrator See also:
> [Actor / Organization Model](/reference/actor-organization-model),
> [API Key Management](/reference/api-key-management),
> [RBAC Policy](/reference/rbac-policy),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Audit Events](/reference/audit-events), [Env Vars](/reference/env-vars)

This reference defines the v1 contract between the Takosumi kernel and the
credential verification surfaces it accepts: the closed provider type enum, the
per-provider configuration, the resolution flow that turns a presented
credential into an `actor:<id>`, the multi-provider composition rule, and the
audit events emitted across provider lifecycle.

The provider plugin set is closed in v1. Operators may not add new provider
types unilaterally. Adding a provider type, repurposing an existing type, or
extending the verify contract requires the `CONVENTIONS.md` §6 RFC.

::: info Current HTTP status The auth-provider control-plane endpoints in this
reference are a design / service contract. The current kernel HTTP router does
not mount `/api/internal/v1/auth-providers`; see
[Kernel HTTP API — Design-Reserved Internal Surfaces](/reference/kernel-http-api#design-reserved-internal-surfaces).
The `TAKOSUMI_AUTH_PROVIDERS_JSON` boot-time loader described below is also a
design contract, not current boot code. :::

## Closed provider type enum

```text
bearer-token | oidc | mtls | runtime-agent-enrollment
```

| Type                       | Verify primitive                                                                                       | Actor mapping                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `bearer-token`             | `Authorization: Bearer <token>` resolved against the API key store.                                    | The Actor recorded on the API key record.                                                                              |
| `oidc`                     | OIDC `id_token` validated against discovery, signature, audience, issuer, and freshness.               | Resolver pulls the configured `actorClaim` and `orgClaim` from the verified id_token.                                  |
| `mtls`                     | TLS peer certificate validated against the operator-provided CA bundle and certificate revocation set. | Subject DN mapped through `subjectActorMap` to an `actor:<id>` and `organization:<id>`.                                |
| `runtime-agent-enrollment` | Enrollment token + agent-side proof-of-possession verified at first connect; mTLS thereafter.          | Kernel mints a new `actor:<id>` with type `runtime-agent` on first enrollment; subsequent connects map the agent cert. |

`bearer-token` is the path API keys flow through; see
[API Key Management](/reference/api-key-management). `oidc` is the typical
surface for human Actors. `mtls` is the path operator-owned service-account or
runtime-agent processes use. `runtime-agent-enrollment` is the bootstrap surface
for new runtime-agent processes; once enrolled, a runtime-agent authenticates
via `mtls` for steady-state.

## Provider record

Each enabled provider is persisted as a `auth-provider` record:

```yaml
AuthProvider:
  id: auth-provider:acme-oidc
  type: oidc
  enabled: true
  registeredAt: 2026-04-12T07:43:11.214Z
  config:
    discoveryUrl: https://idp.acme.example/.well-known/openid-configuration
    clientId: takosumi-kernel
    clientSecretRef: secret://global/oidc/acme-client-secret
    audience: takosumi-kernel
    actorClaim: sub
    orgClaim: organizations
    allowedAlgorithms: [RS256, ES256]
    clockSkewSec: 60
```

Field semantics:

| Field          | Required | Notes                                                                                                             |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | `auth-provider:<id>` form. Operator-controlled name; immutable.                                                   |
| `type`         | yes      | One of the four closed enum values above.                                                                         |
| `enabled`      | yes      | Operator-controlled toggle. Disabled providers reject every request without consulting `config`.                  |
| `registeredAt` | yes      | RFC 3339 UTC, millisecond precision.                                                                              |
| `config`       | yes      | Per-type configuration object (below). The shape is closed per type; unknown fields are rejected at registration. |

### `oidc` config

| Field               | Required | Notes                                                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `discoveryUrl`      | yes      | Operator-controlled OIDC discovery URL. The kernel caches the document for the discovery TTL.                      |
| `clientId`          | yes      | OIDC RP client id.                                                                                                 |
| `clientSecretRef`   | yes      | `secret://<partition>/<key>` reference; never inline.                                                              |
| `audience`          | yes      | Required `aud` claim value.                                                                                        |
| `actorClaim`        | yes      | Claim key used to derive the Actor id (typically `sub` or a stable email).                                         |
| `orgClaim`          | no       | Claim key used to map to an Organization. When absent, the kernel falls back to the operator-policy mapping table. |
| `allowedAlgorithms` | yes      | Closed allow-list of JWS algorithms; the kernel rejects others.                                                    |
| `clockSkewSec`      | no       | Tolerance for `iat` / `exp` skew. Default `60`.                                                                    |

The kernel never trusts an id_token whose `iss` differs from the discovery
document's `issuer`, whose `aud` does not include `audience`, whose `exp` is
past, or whose signature does not verify under the discovery's `jwks_uri`.

### `mtls` config

| Field               | Required | Notes                                                                          |
| ------------------- | -------- | ------------------------------------------------------------------------------ |
| `caBundleRef`       | yes      | `secret://<partition>/<key>` reference to a PEM CA bundle.                     |
| `subjectActorMap`   | yes      | Operator-defined mapping from subject DN regex to `(actorId, organizationId)`. |
| `revocationListRef` | no       | Optional CRL or OCSP-stapling configuration reference.                         |

### `runtime-agent-enrollment` config

| Field                 | Required | Notes                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `enrollmentTokenRef`  | yes      | `secret://<partition>/<key>` reference; rotated through the operator surface.                  |
| `enrollmentExpiresAt` | yes      | Hard expiry on the active enrollment token. Past expiry, all enrollment attempts are rejected. |
| `caBundleRef`         | yes      | Steady-state mTLS CA bundle for the post-enrollment session.                                   |

### `bearer-token` config

`bearer-token` does not carry verifier configuration beyond the API key store;
the API key record itself pins type, scope, and storage rules. See
[API Key Management](/reference/api-key-management).

## Resolution flow

The kernel runs the same resolution flow for every authenticated request:

1. **Provider selection.** The router inspects request shape (HTTP header, TLS
   layer) to choose a provider type:
   - `Authorization: Bearer ...` and a matching API key prefix → `bearer-token`.
   - `Authorization: Bearer ...` and a JWT-shaped token → `oidc` (across enabled
     OIDC providers).
   - TLS peer certificate present and verified → `mtls` (across enabled mTLS
     providers).
   - Runtime-agent enrollment header → `runtime-agent-enrollment`.
2. **Provider verify.** The kernel calls the matched provider's verify
   primitive. A failure returns `unauthenticated` (see
   [Closed Enums — DomainErrorCode](/reference/closed-enums#domainerrorcode))
   with no further information.
3. **Actor resolve.** The verified credential maps to an `actor:<id>`. For
   `oidc`, the resolver also derives the `organization:<id>` set; for `mtls` and
   `runtime-agent-enrollment`, the mapping table or enrollment record provides
   it; for `bearer-token`, the API key record carries it.
4. **Membership and role load.** The resolver loads the Actor's Memberships and
   active RoleAssignments (see [RBAC Policy](/reference/rbac-policy)).
5. **RBAC enforcement.** The router runs the matrix check before any state
   mutation. Failure returns `permission_denied`.

When a request matches **no** enabled provider, the kernel returns
`unauthenticated` without surfacing which providers are available. When a
request matches multiple enabled providers (for example, two OIDC providers
configured with overlapping discovery URLs), the kernel rejects the request as
ambiguous and emits `auth-resolution-ambiguous`; operators resolve ambiguity by
tuning the provider's `config` to be selective.

## Multi-provider composition

A single kernel may run any number of enabled providers concurrently. The
composition rule is:

- An Actor is bound to exactly one provider for the lifetime of that Actor. The
  provider is recorded on the Actor record at creation time and is immutable.
- Switching an Actor's auth source (for example, moving a human from
  `bearer-token` to `oidc`) mints a new Actor. The kernel never re-binds an
  existing Actor to a different provider.
- The same human, identified by the same email at the IdP and the same
  operator-issued bearer, results in two distinct `actor:<id>` values. Operators
  that want a single audit identity per real-world user route exclusively
  through one provider.

This rule keeps audit, RBAC, and approval invalidation reasoning provider-local:
an Actor's role set never spans provider boundaries.

## Configuration

Two paths configure providers; operators pick one or use both.

### Environment variable (design-reserved)

```text
TAKOSUMI_AUTH_PROVIDERS_JSON
```

A JSON array of `AuthProvider` records. The design target loads it at boot.
Useful for single-provider deployments and for bootstrap before the operator
control plane is reachable.

### Operator control plane (design-reserved)

```text
POST   /api/internal/v1/auth-providers
PATCH  /api/internal/v1/auth-providers/:id
DELETE /api/internal/v1/auth-providers/:id
GET    /api/internal/v1/auth-providers
```

Authenticated through the kernel's internal HMAC. Mutations through this surface
would persist to the storage backend and survive restart, overriding any
matching `TAKOSUMI_AUTH_PROVIDERS_JSON` entry. This surface is not mounted by
the current kernel HTTP router.

Both surfaces follow the same record shape and the same closed config schema per
type; operators do not have a way to inject out-of-schema fields.

## Audit events

Auth provider lifecycle and verification add four closed audit event types under
the "Identity" group of [Audit Events](/reference/audit-events):

```text
auth-provider-registered
auth-provider-revoked
auth-success
auth-failure
```

`auth-success` is emitted on a sampled basis (operator-tunable) to bound
audit-store growth, mirroring `api-key-used`. `auth-failure` is emitted
unconditionally and carries the redacted reason (`token_expired`,
`signature_invalid`, `audience_mismatch`, `unknown_provider`,
`ambiguous_provider`, `cert_revoked`, `enrollment_token_expired`,
`actor_not_resolvable`). Plaintext credentials never appear in any of these
events.

## Scope boundary

The Takosumi kernel ships the four-value provider enum, the per-type config
schemas, the resolution flow, and the audit events listed above; that is the
entire v1 auth surface. The kernel does **not** ship vendor selection (Auth0 vs
Okta vs Keycloak vs an in-house IdP), tenant-specific OIDC application
provisioning, end-user login pages, password-reset UX, MFA prompts, or any
branded sign-in screen. Operators that want a richer surface for their end users
select an IdP, configure the kernel to verify its id_tokens, and host the
sign-in surface from outside (for example, in `takos-private/` or in a separate
identity-provider stack). The kernel exposes the verify primitive that those
outer surfaces compose against.

## Related design notes

- docs/design/policy-risk-approval-error-model.md
- docs/design/snapshot-model.md
- docs/design/space-model.md
