# Resource IDs

> Stability: stable Audience: kernel-implementer, integrator See also:
> [Closed Enums](/reference/closed-enums),
> [Connector Contract](/reference/connector-contract),
> [Storage Schema](/reference/storage-schema),
> [Digest Computation](/reference/digest-computation),
> [Actor / Organization Model](/reference/actor-organization-model),
> [API Key Management](/reference/api-key-management),
> [Auth Providers](/reference/auth-providers),
> [RBAC Policy](/reference/rbac-policy),
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Tenant Export and Deletion](/reference/tenant-export-deletion),
> [Trial Spaces](/reference/trial-spaces),
> [Cost Attribution](/reference/cost-attribution),
> [Quota Tiers](/reference/quota-tiers),
> [SLA Breach Detection](/reference/sla-breach-detection),
> [Incident Model](/reference/incident-model),
> [Support Impersonation](/reference/support-impersonation),
> [Notification Emission](/reference/notification-emission),
> [Zone Selection](/reference/zone-selection)

This page defines the Takosumi v1 resource ID grammar, the closed list of v1 ID
kinds, the suffix grammar each kind uses, the canonical and display forms used
at the kernel boundary, and the stability rules that govern which IDs may be
regenerated and which are fixed forever.

Resource IDs are the **only** identity surface the kernel persists. No other
identifier (operator-internal numeric primary keys, runtime- agent local
handles, connector handles) is stable across kernel restarts. The surface
defined here is what kernel API responses, audit events, snapshots, journal
entries, and CLI output expose.

## ID grammar

Every Takosumi v1 resource ID has the closed shape:

```text
<kind>:<unique-suffix>
```

Rules:

- `kind` is a kebab-case ASCII identifier from the closed list below.
- `:` is the single delimiter between the kind and the suffix; the suffix may
  not contain a literal `:` for any v1 kind.
- `unique-suffix` follows a kind-specific grammar (ULID, UUID v4, sha256 hex,
  content-addressed hash, or a kebab-case operator-controlled name).
- The full ID is case-sensitive. ULID suffixes use Crockford's base32 alphabet
  which is uppercase by convention; sha256 suffixes are lowercase hex.
- Whitespace is forbidden anywhere in the ID. Trailing or leading whitespace is
  rejected at ingest.

`<kind>:` is treated as a reserved prefix. Plugin authors and operators may not
invent new kinds. New kinds require a `CONVENTIONS.md` §6 RFC.

## v1 closed kind list

The kind list is closed in v1. The base table below enumerates the kernel-domain
kinds (manifest, journal, snapshot, share, group); the PaaS-provider primitive
additions follow under
[v1 closed kind additions for PaaS provider primitives](#v1-closed-kind-additions-for-paas-provider-primitives).
The closure rule is unchanged: every kind that the kernel accepts at the API
boundary appears in either the base table or the addition table, and every other
kind is rejected.

| Kind                   | Suffix grammar                           | Source of suffix                                                  |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `space`                | kebab-case name                          | Operator-controlled.                                              |
| `deployment`           | ULID                                     | Kernel-generated on apply.                                        |
| `link`                 | `<consumer>.<slot>`                      | Derived from consumer object ID and slot name.                    |
| `object`               | kebab-case name                          | Operator-controlled within a Space.                               |
| `generated`            | `<owner-kind>:<owner-id>/<reason>`       | Kernel-generated, deterministic from owner.                       |
| `exposure`             | kebab-case name                          | Operator-controlled within a Space.                               |
| `journal`              | ULID                                     | Kernel-generated per WAL entry.                                   |
| `operation`            | ULID                                     | Kernel-generated per OperationPlan entry.                         |
| `desired`              | sha256 hex                               | Content-addressed over the DesiredSnapshot canonical encoding.    |
| `resolution`           | sha256 hex                               | Content-addressed over the ResolutionSnapshot canonical encoding. |
| `activation`           | ULID                                     | Kernel-generated on activate.                                     |
| `revoke-debt`          | ULID                                     | Kernel-generated when the entry is enqueued.                      |
| `approval`             | ULID                                     | Kernel-generated on approval.                                     |
| `share`                | ULID                                     | Kernel-generated for SpaceExportShare.                            |
| `connector`            | kebab-case id                            | Operator-installed.                                               |
| `external-participant` | kebab-case id                            | Operator-controlled.                                              |
| `export-snapshot`      | sha256 hex                               | Content-addressed over the export contents.                       |
| `catalog-release`      | sha256 hex or operator-tagged kebab-case | Content-addressed by default; operator may pin a tag.             |
| `policy`               | sha256 hex                               | Content-addressed over the policy bundle.                         |
| `group`                | kebab-case name                          | Operator-controlled within a Space.                               |

The above is the v1 closed set. Adding a new kind, removing a kind, or changing
the suffix grammar of an existing kind requires the `CONVENTIONS.md` §6 RFC.

### Examples

```text
space:acme-prod
deployment:01HM9N7XK4QY8RT2P5JZF6V3W9
link:object:web-app.database
object:web-app
generated:link:object:web-app.database/projection
exposure:public-api
journal:01HM9N7XK4QY8RT2P5JZF6V3W9
operation:01HM9N7XK4QY8RT2P5JZF6V3W9
desired:sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
resolution:sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
activation:01HM9N7XK4QY8RT2P5JZF6V3W9
revoke-debt:01HM9N7XK4QY8RT2P5JZF6V3W9
approval:01HM9N7XK4QY8RT2P5JZF6V3W9
share:01HM9N7XK4QY8RT2P5JZF6V3W9
connector:cloudflare-workers-bundle
external-participant:partner-org
export-snapshot:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
catalog-release:sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0
policy:sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
group:rollout-canary
```

## v1 closed kind additions for PaaS provider primitives

The kinds below extend the v1 closed kind list with the resources introduced by
the PaaS-provider primitives (identity, tenant lifecycle, quota and SLA
enforcement, incident response, support impersonation, notification). The
closure rule from the section above applies: each addition is bound to a fixed
suffix grammar and a fixed source-of-suffix; new kinds beyond this list still
require a `CONVENTIONS.md` §6 RFC.

### Identity additions

| Kind              | Suffix grammar             | Source of suffix                                                                               | Reference                                                         |
| ----------------- | -------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `actor`           | kebab-case name or UUID v4 | Operator-controlled human or service-account name; UUID v4 when minted by an enrollment flow.  | [Actor / Organization Model](/reference/actor-organization-model) |
| `organization`    | kebab-case name            | Operator-controlled at organization create.                                                    | [Actor / Organization Model](/reference/actor-organization-model) |
| `membership`      | ULID                       | Kernel-generated on Membership create.                                                         | [Actor / Organization Model](/reference/actor-organization-model) |
| `role-assignment` | ULID                       | Kernel-generated on RoleAssignment create.                                                     | [RBAC Policy](/reference/rbac-policy)                             |
| `api-key`         | ULID                       | Kernel-generated on issue. The plaintext token is independent and is never embedded in the ID. | [API Key Management](/reference/api-key-management)               |
| `auth-provider`   | kebab-case name            | Operator-controlled at auth provider register.                                                 | [Auth Providers](/reference/auth-providers)                       |

`actor:` admits a sub-kind discriminator for support-staff Actors: the form
`actor:support-staff/<id>` is the only sub-kind shape in v1 (see
[Support Impersonation](/reference/support-impersonation)). Other Actor types
use the bare `actor:<name>` or `actor:<uuid>` form. The suffix may not contain a
`:`; the `/` separates the Actor sub-kind discriminator and is the only `/`
permitted in an Actor ID.

### PaaS operations additions

| Kind                   | Suffix grammar  | Source of suffix                                            | Reference                                                       |
| ---------------------- | --------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `tier`                 | kebab-case name | Operator-controlled at quota tier register.                 | [Quota Tiers](/reference/quota-tiers)                           |
| `incident`             | ULID            | Kernel-generated on incident open.                          | [Incident Model](/reference/incident-model)                     |
| `support-grant`        | ULID            | Kernel-generated on operator grant create.                  | [Support Impersonation](/reference/support-impersonation)       |
| `support-session`      | ULID            | Kernel-generated on session open under an `approved` grant. | [Support Impersonation](/reference/support-impersonation)       |
| `notification-signal`  | ULID            | Kernel-generated on notification signal emit.               | [Notification Emission](/reference/notification-emission)       |
| `provisioning-session` | ULID            | Kernel-generated on tenant provisioning session start.      | [Tenant Provisioning](/reference/tenant-provisioning)           |
| `export-job`           | ULID            | Kernel-generated on Space export request.                   | [Tenant Export and Deletion](/reference/tenant-export-deletion) |
| `sla-threshold`        | ULID            | Kernel-generated on operator SLA threshold register.        | [SLA Breach Detection](/reference/sla-breach-detection)         |
| `sla-observation`      | ULID            | Kernel-generated on SLA observation emit.                   | [SLA Breach Detection](/reference/sla-breach-detection)         |

The closure rule applies to this addition table: a kind is fixed to exactly one
suffix grammar; the `tier:` operator name is the only non-ULID kind in this
addition table. Adding a new kind beyond this list requires the `CONVENTIONS.md`
§6 RFC. The addition table does not relax the v1 grammar
(`<kind>:<unique-suffix>`, kebab-case `kind`, no `:` inside the suffix); the
`actor:support-staff/<id>` sub-kind is the single permitted exception and is
bound to the `actor:` kind only.

### Examples

```text
actor:alice
actor:b3a1f6e8-3d6f-4b2a-9c1d-2c7a8e0f5a31
actor:support-staff/jane
organization:acme
membership:01HM9N7XK4QY8RT2P5JZF6V3W9
role-assignment:01HM9N7XK4QY8RT2P5JZF6V3WA
api-key:01HM9N7XK4QY8RT2P5JZF6V3WB
auth-provider:acme-oidc
tier:pro
incident:01HM9N7XK4QY8RT2P5JZF6V3WC
support-grant:01HM9N7XK4QY8RT2P5JZF6V3WD
support-session:01HM9N7XK4QY8RT2P5JZF6V3WE
notification-signal:01HM9N7XK4QY8RT2P5JZF6V3WF
provisioning-session:01HM9N7XK4QY8RT2P5JZF6V3WG
export-job:01HM9N7XK4QY8RT2P5JZF6V3WH
sla-threshold:01HM9N7XK4QY8RT2P5JZF6V3WJ
sla-observation:01HM9N7XK4QY8RT2P5JZF6V3WK
```

### Stability classification

The addition kinds slot into the stability rules from the section below.

- **Operator-controlled names (immutable, no rename)**: `organization:`,
  `auth-provider:`, `tier:`. Operator-named `actor:` IDs follow the same rule;
  UUID-form `actor:` IDs are treated as kernel-minted.
- **Kernel-minted ULIDs (immutable once issued)**: `membership:`,
  `role-assignment:`, `api-key:`, `incident:`, `support-grant:`,
  `support-session:`, `notification-signal:`, `provisioning-session:`,
  `export-job:`, `sla-threshold:`, `sla-observation:`.

The addition table does not introduce content-addressed kinds; SHA suffixes are
reserved for the kinds enumerated in the original section.

## Suffix grammars

Each suffix grammar is closed in v1.

### ULID

26-character Crockford's base32, time-sortable. Generated with a
millisecond-resolution timestamp prefix and 80 bits of randomness. Lexicographic
order matches creation order to within the timestamp resolution. ULIDs are fixed
once minted; the kernel never reissues an ID for the same logical resource.

### UUID v4

Reserved for forward compatibility; no v1 kind currently uses UUID v4. The
grammar (canonical hyphenated lowercase form) is documented for future kinds
without committing kernel storage to support them today.

### sha256 hex

Lowercase hexadecimal of a SHA-256 digest. Always 64 characters. The ID embeds
the hash with a leading `sha256:` token to leave room for future hash algorithms
behind a `CONVENTIONS.md` §6 RFC. Content- addressed kinds follow the canonical
encoding rules in [Digest Computation](/reference/digest-computation).

### kebab-case name

ASCII lowercase letters, digits, and `-`. Must start with a letter, must not end
with `-`, must not contain consecutive `-`. Maximum length is 63 characters.
Operator-controlled kinds (`space`, `object`, `exposure`, `connector`,
`external-participant`, `group`, operator-tagged `catalog-release`) use this
grammar.

### Composite suffixes

Two kinds use composite suffixes derived from other IDs.

- `link:<consumer>.<slot>` — `<consumer>` is the consumer object's full ID (with
  its own kind prefix); `<slot>` is the slot name as declared in the consumer's
  shape spec.
- `generated:<owner-kind>:<owner-id>/<reason>` — `<owner-kind>` and `<owner-id>`
  identify the owning resource; `<reason>` is a closed short token (e.g.
  `projection`, `materialization`) that the kernel selects at generation time.

Composite suffix construction is deterministic: the same owner and reason always
produce the same generated ID. Replays of the same projection rule do not mint
new generated IDs.

## Display form

IDs are surfaced in two equivalent forms.

- **Canonical**: `<kind>:<suffix>` as a single string. This is the form
  persisted in storage, embedded in JSON, and emitted by the audit log.
- **Tuple form**: `(space:<name>, <kind>:<suffix>)` when the ID's Space context
  matters. The kernel emits tuple form in cross-Space references and in CLI
  output that aggregates across Spaces.

Human-readable display in CLI output uses the **path form**:

```text
space:acme-prod/deployment:01HM9N7XK4QY8RT2P5JZF6V3W9
```

Path form joins the Space ID and the resource ID with a single `/`. Path form is
informational only; the canonical form is the source of truth at the kernel
boundary.

## Cross-Space references

When a resource in Space A references a resource in Space B (e.g. through a
`SpaceExportShare`), the kernel uses tuple form:

```text
(space:b-prod, object:shared-config)
```

Tuple form is required at every cross-Space surface: snapshot fields, audit
events, and approval bindings. Bare `<kind>:<suffix>` IDs are implicitly
Space-local and refer to the active Space context.

## ID stability rules

The stability of an ID depends on its kind.

### Content-addressed (immutable forever)

`desired:sha256:...`, `resolution:sha256:...`, `export-snapshot:sha256:...`,
`policy:sha256:...`, content-addressed `catalog-release:sha256:...`. These IDs
are the hash of their contents; mutating the contents produces a new ID, never
reuses an existing one. The kernel may safely cache, pin, or share these IDs
across Spaces.

### Kernel-minted ULIDs (immutable once issued)

`deployment:`, `journal:`, `operation:`, `activation:`, `revoke-debt:`,
`approval:`, `share:`. Once the kernel issues such an ID, it persists for the
lifetime of the resource and is never reassigned to a different resource.

### Operator-controlled names (immutable, no rename)

`space:`, `object:`, `exposure:`, `connector:`, `external-participant:`,
`group:`. The operator chooses the name on creation; rename is **not** supported
in v1. A future rename API would land through a `CONVENTIONS.md` §6 RFC and
would be additive (creating an alias), not destructive (rewriting historical
references).

### Deterministic composite IDs (stable per source)

`link:` and `generated:`. These IDs are derived from their source inputs
(consumer + slot for links, owner + reason for generated objects). Re-running
the projection produces the same ID. Removing the source removes the ID; the
kernel does not reuse a removed composite ID for an unrelated resource later.

## Reserved kinds and forward compatibility

The kinds enumerated above are the **complete** v1 set. Adding a new kind,
repurposing an existing kind, or aliasing a kind requires a `CONVENTIONS.md` §6
RFC.

The `<kind>:<suffix>` shape is the only ID grammar the kernel recognizes.
Strings outside this grammar are not valid IDs and are rejected by every kernel
surface that ingests IDs (apply input, storage write, audit ingest, CLI flag
parsing).

## Related design notes

- docs/design/object-model.md
- docs/design/space-model.md
- docs/design/snapshot-model.md
- docs/design/link-projection-model.md
- docs/design/data-asset-model.md
