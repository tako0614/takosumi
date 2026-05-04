# Access Modes

> Stability: stable
> Audience: integrator
> See also: [Closed Enums](/reference/closed-enums), [Shape Catalog](/reference/shapes), [Provider Plugins](/reference/providers)

The Takosumi v1 access mode enum is the closed vocabulary that governs how a
Link consumer interacts with an export's resource. It is the canonical
authority field on grant-producing exports and on link declarations that
project an export into a consuming Space.

```text
read | read-write | admin | invoke-only | observe-only
```

The enum is closed. Adding a mode requires a `CONVENTIONS.md` §6 RFC. No
provider, connector, or template extends it unilaterally.

## Mode semantics

### `read`

Observation-only access to the export's underlying resource. The consumer
may read state (object payload, table rows, queue depth, configuration),
subscribe to materialized snapshots, and inspect schema. **No grant
material is generated** beyond what is needed to authenticate the read,
and no mutation API surface is projected.

Allowed: select / get / list / describe / subscribe.
Not allowed: any state-changing call on the resource.

Typical use: a `web-service` shape consuming a `database` shape's
`read` link to power a status dashboard; a downstream Space consuming an
external tenant's `bucket` shape for analytics-only.

### `read-write`

`read` plus mutation rights on the export's primary state surface. The
consumer may both observe and update the resource through the API
contract that the shape defines as its mutation surface.

Allowed: everything in `read`, plus insert / update / upsert / delete
within the shape's mutation contract.
Not allowed: lifecycle administration of the resource (recreate, drop,
re-shard, rotate root credential, delete the resource container itself).

Typical use: a backend `web-service` writing to its own `database`
shape; a worker shape pushing into an `object-store` shape.

### `admin`

Full management of the export's resource. The consumer can perform
mutation **and** lifecycle administration (rotate credentials, recreate,
re-shard, drop), within the limits the provider enforces at its
boundary. Treated as the most privileged closed-enum value.

Allowed: everything in `read-write`, plus shape-defined administrative
operations.
Not allowed: nothing within the resource scope; cross-resource
administrative implications (e.g. revoking links granted from this
export) still go through the kernel's grant model.

`admin` is never an implicit default. Defaults that imply admin must be
declared explicitly on the link, never derived from `safeDefaultAccess`.

Typical use: an operator-facing control plane Space that manages the
underlying database for a tenant; rare in tenant Spaces.

### `invoke-only`

The consumer may call the resource through the shape's invocation
surface but cannot read or mutate underlying state directly. State
inspection is available only through the invocation result envelope
that the shape defines.

Allowed: invoke / call / publish / submit through the shape's
invocation contract.
Not allowed: read of stored state, observation of internal queues,
mutation outside the invocation envelope.

Typical use: a `web-service` invoking another `web-service`'s public
API; a producer publishing to a queue without read on the queue
itself.

### `observe-only`

The consumer may receive notifications, metrics, or projection events
the export emits, but holds no access to the resource itself. No
synchronous read, no invocation, no mutation.

Allowed: metric / event / notification consumption through the
shape's observation surface.
Not allowed: any direct interaction with the resource.

Typical use: a metrics aggregator subscribing to many export's
emission streams; a SIEM consumer.

## `safeDefaultAccess`

A shape may declare `safeDefaultAccess` on an export that participates
in `${ref:...}` resolution without an explicit `access` field on the
consuming link. The value picked must be one of the closed modes above.

The contract:

- `safeDefaultAccess` may be `null`, `read`, `invoke-only`, or
  `observe-only`. `read-write` and `admin` are **never** valid as
  defaults.
- A grant-producing export with `safeDefaultAccess: null` requires the
  consuming link to specify `access` explicitly. Resolution fails with
  `access-required` otherwise.
- The resolved access mode is recorded on the
  `ResolutionSnapshot.linkProjections[].access` slot, regardless of
  whether it came from the explicit link field or the default.

## Where `access` is required on the link

The link declaration must carry `access` explicitly when:

- The export's `safeDefaultAccess` is `null`.
- The link projects a grant-producing export and the consuming
  shape's spec marks the slot as requiring grant detail.
- The operator policy pack forbids implicit access on the export's
  shape (`prod/strict` and `enterprise/catalog-approved-only` enable
  this).

When `access` is provided, kernel validation rejects modes that the
shape's `outputFields` declares unsupported.

## Approval invalidation interaction

A change to the resolved access mode on any link projection counts as
the **effect-detail change** trigger in the approval invalidation
enum. An existing approval bound to a `ResolutionSnapshot` is
short-circuit invalidated when:

- A consuming link toggles `access` from one mode to another.
- The export's `safeDefaultAccess` changes and a consuming link
  relied on the default.
- A grant-producing export newly gates an access mode behind operator
  policy review.

The full set of approval invalidation triggers lives in
[Closed Enums](/reference/closed-enums). The access-mode-driven
invalidation is the most common cause of `effect-detail change` in
practice and is the reason `read-write` and `admin` always require an
explicit declaration on the link.

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/target-model.md` — access mode enum closure rationale
  と `safeDefaultAccess` の choice space
- `docs/design/link-projection-model.md` — link projection が access
  mode を `${ref:...}` resolver に通す経路と effect-detail への影響
- `docs/design/namespace-export-model.md` — grant-producing default
  が `admin` を取り得ない理由と export 側からの enforcement
