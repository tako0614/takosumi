# Identity and Access Design

This document records the design rationale for the v1 identity and access primitives that Takosumi persists when it is operated as a PaaS: Actor, Organization, Membership, role-based access control, API keys, and pluggable auth providers. Wire shape and field grammar live in the reference layer; this document explains why these primitives sit inside the kernel rather than in the outer operator stack.

## Why kernel-side

Identity and access are kernel-side because the v1 isolation invariants are kernel-side. `Space` is the boundary of meaning, authority, and ownership ([Space Model](./space-model.md)); every namespace lookup, journal entry, observation, secret partition, and approval is Space-scoped. If the kernel did not know which Actor authenticated, which Organization owns a Space, and which role assignments bind that Actor to that Space, the kernel could not enforce its own containment invariants. Each operator distribution would then re-implement those invariants on top of the kernel, and Space isolation would be a property of the outer stack instead of the kernel.

The design rule is therefore: **the kernel ships the identity primitives that its own invariants reference, and nothing more.** Customer signup forms, branding, billing-contact validation, anti-abuse heuristics, end-user dashboards, and the admin escalation workflow live outside Takosumi.

## Actor and Organization model rationale

Three primitives form the v1 identity skeleton:

```text
Actor             every authenticated principal
Organization      the tenancy unit that owns one or more Spaces
Membership        the bind between an Actor and an Organization
```

Design choices and the reason each is fixed:

- **Org-Space 1:N is the minimal expression of tenant hierarchy.** A customer that operates `prod`, `staging`, and `dev` as three Spaces still bills, audits, and contracts under one Organization. Collapsing the two would force every customer into one Space; expanding to N:M would let one Space straddle two contractual boundaries and break the audit chain.
- **1 Space = 1 Organization is an invariant, not a default.** The Space record carries `organizationId` as a required immutable field. Cross-Org operations are not expressible without an explicit `SpaceExportShare` (see [Space Model](./space-model.md)). This is the wire-level expression of the security boundary that the operator-boundaries doc states as policy.
- **Actor minting is one-way.** Token rotation does not change `actor:<id>`. Switching auth provider mints a new Actor. This keeps `actor:<id>` stable as the audit-chain key while still supporting credential rotation, and it removes the class of bugs where audit history points at an Actor whose authentication source has silently changed.
- **Membership is the unit RBAC binds to, not the Organization.** Role assignments attach to `(Actor, Organization)` or `(Actor, Space, Organization)` tuples through the Membership record. Removing the last `org-owner` is rejected; demotion requires another Actor first hold `org-owner`. Both rules exist so that the kernel never produces an Organization that no Actor can administer.

## RBAC enum closure rationale

The role enum is closed at seven values: `org-owner`, `org-admin`, `org-billing`, `space-admin`, `space-deployer`, `space-viewer`, `support-staff`. Custom roles are out of scope for v1. The reasoning is:

- **A closed enum lets the permission matrix be a kernel invariant.** Each operation kind in the kernel HTTP surface has one column per role with a fixed permit / deny decision. Adding a role would expand the matrix in every reference that mentions a permission. Keeping the enum closed makes the matrix a single artifact the kernel can reason about, not a per-operator policy document.
- **Operator policy still composes.** Operators are free to apply UI labels above the closed roles, gate role assignment through outer workflows, or expose only a subset of roles to a given customer tier. The operator-side composition path is **role assignment**, not new role names. The kernel-side enforcement vocabulary stays stable across operator distributions.
- **`support-staff` is intentionally outside the customer role tree.** A support-staff Actor never appears in a Membership and never holds a Space role directly. Its authority is mediated by the impersonation primitive (see [PaaS Operations Design](./paas-operations-design.md)) so that every cross-tenant access has an audit-grade evidence trail.

## API key vs OIDC vs mTLS

Four credential paths flow through the kernel; each is the right primitive for one specific Actor class:

```text
bearer-token              CLI / programmatic / scripted access (humans + service accounts)
oidc                      human Actors authenticating through corporate SSO
mtls                      service-to-service, including operator-owned automation
runtime-agent-enrollment  bootstrap path for runtime-agent processes only
```

Design rationale:

- **Each provider matches the credential a real caller already has.** A CLI user holds a bearer token. A human in front of a browser holds an OIDC id_token. A runtime-agent process holds a TLS client certificate. Forcing one provider for all classes would either weaken the strong cases (mTLS for humans is not better than SSO) or burden the weak cases (mTLS for a one-off CLI invocation is impractical).
- **API keys are the bearer-token specialization.** The kernel persists a hash, never the cleartext value. Effective permissions are the intersection of the key's capability cap (`deploy-token`, `read-token`, `admin-token`) and the issuing Actor's roles at request time. Demoting an Actor demotes every key it owns, regardless of when the key was minted.
- **Provider binding is immutable per Actor.** Actor identity follows the **provider-binding-immutable invariant**: one Actor record is bound for life to the provider that minted it. An Actor authenticated via `oidc` is never reattached to `bearer-token`; rebinding does not exist. When a real-world caller's auth source switches (for example, a human moves from `bearer-token` to `oidc`), the kernel models that switch by minting a new Actor identity, not by mutating the existing record. This is consistent with the reference behaviour (`docs/reference/auth-providers.md` "Multi-provider composition"): a credential rotation that crosses provider boundaries always produces a new `actor:<id>`, which prevents the class of bugs where a rotation silently widens authority.
- **`runtime-agent-enrollment` is a one-time bootstrap.** After enrollment, a runtime-agent authenticates via `mtls`. Keeping enrollment separate stops a long-lived enrollment token from doubling as a steady-state credential.

## Why auth providers are plugin-shaped

The kernel does not embed an OIDC implementation, an mTLS validator, or an API key store as fixed code paths. Each provider plugs into a verify-and-resolve contract that turns a presented credential into an `actor:<id>` plus the relevant Organization context. The reasoning:

- **Operators do not share an IdP.** Different PaaS distributions stand in front of different identity stacks. Hard-wiring the kernel to one IdP would force every operator to either re-implement that stack or accept a foreign one.
- **Adapter contract keeps the auth state machine common.** All four providers feed into the same Actor record, the same RBAC matrix, and the same audit chain. The adapter line is where vendor-specific verification lives; everything downstream of resolution is operator-independent.
- **Disabled providers reject without consulting config.** This is a safety property: an operator who disables a provider must not be able to leak credentials by misconfiguring its `config` block.

## Boundary

The kernel ships:

- the Actor / Organization / Membership records and their lifecycle;
- the closed role enum and its permission matrix;
- the API key primitives (issue, rotate, revoke, hash-only storage);
- the four auth provider plugin contracts and the resolution flow that maps a presented credential to an Actor.

The kernel does not ship:

- signin pages, account dashboards, "forgot password" flows;
- token-list UIs, role-assignment UIs, customer-facing invite flows;
- billing-contact verification against external billing systems;
- branding, localized email templates, anti-abuse heuristics;
- the IdP itself.

These are operator surfaces. They consume the kernel primitives through the internal control plane and the public actor self-service plane, but they are not part of Takosumi.

## Related reference docs

- [Actor / Organization Model](../reference/actor-organization-model.md)
- [RBAC Policy](../reference/rbac-policy.md)
- [API Key Management](../reference/api-key-management.md)
- [Auth Providers](../reference/auth-providers.md)
- [Audit Events](../reference/audit-events.md)
- [Kernel HTTP API](../reference/kernel-http-api.md)

## Cross-references

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [PaaS Provider Design](./paas-provider-design.md)
- [Tenant Lifecycle Design](./tenant-lifecycle-design.md)
- [PaaS Operations Design](./paas-operations-design.md)
