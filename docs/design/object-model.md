# Object Model

Object is the canonical entity in the kernel graph. Every Object belongs to
exactly one Space. A public `resources[]` entry becomes an Object intent, then a
resolved Object.

## Space-qualified identity

Object addresses are unique within a Space. Storage should treat identity as a
tuple.

```text
(spaceId, objectAddress)
```

Qualified display form is allowed for logs and plans.

```text
space:acme-prod/object:api
```

An Object in one Space must never be updated, deleted, or observed as authority
for another Space.

## Object lifecycle classes

```text
managed:
  Takosumi may create, update, replace, delete.

generated:
  Created by a Link, Exposure, DataAsset transform, composite target, or operation.
  Must carry owner, reason, delete policy, and deterministic identity.

external:
  Owned outside Takosumi. Takosumi may verify, observe, link, and request grants.
  Takosumi must not create or delete it.

operator:
  Owned by operator platform. User deployment may link to approved exports.
  User deployment must not delete it.

imported:
  Existing object registered by operator policy. Delete is denied unless explicitly approved.
```

## Object record

```yaml
Object:
  spaceId: space:acme-prod
  address: object:api
  lifecycleClass: managed
  shape: web-service@v1
  provider: "@takos/cloudflare-workers"
  targetDescriptorDigest: sha256:...
  owner:
    kind: deployment
    id: deployment:...
  desiredGeneration: 3
  labels: {}
```

## Generated object requirements

Every generated object has:

```yaml
GeneratedObject:
  address: generated:link:api.DATABASE_URL/grant
  owner: link:api.DATABASE_URL
  reason: link-materialization
  deterministicId: sha256:...
  deletePolicy: delete-with-owner | retain-with-approval | revoke-with-owner
  lifecycleClass: generated
```

Generated object identity is recorded before side effects begin.

## Object revoke flow

Revoke is the lifecycle that replaces a managed or generated object with its
absence while honoring external constraints. The state machine:

```text
live → revoking → revoked
            \
             → debt          (revoke could not complete cleanly)
```

Revoke participation is restricted by lifecycle class. `external-source` and
`external-participant` (the `external` and `operator` rows below) must never
enter this flow as the revoke target; only their generated children may. This
re-states the [Invariant-first Root Model](./invariant-first-root-model.md)
external-ownership invariant.

When external cleanup is required and the external system rejects or cannot
acknowledge the revoke, the link's owner queues a `RevokeDebt` record per
[Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
and the object enters the `debt` state until the debt is cleared.

## Revoke participation matrix

Rows are object lifecycle classes. Columns are the four operations involved in
tearing an object down. `yes` allows the operation; `gen-only` allows it only on
the object's generated children, never on the object itself; `no` forbids the
operation; `debt-on-fail` describes whether a failed external cleanup queues
`RevokeDebt`.

| Lifecycle class | delete             | revoke             | detach       | debt-on-fail |
| --------------- | ------------------ | ------------------ | ------------ | ------------ |
| managed         | yes                | yes                | yes          | yes          |
| generated       | by owner operation | by owner operation | yes          | yes          |
| external        | no                 | gen-only           | yes          | gen-only     |
| operator        | no                 | gen-only           | policy-gated | gen-only     |
| imported        | policy-gated       | gen-only           | yes          | gen-only     |

`detach` removes the consumer-side reference (Link or Exposure) without mutating
the source object; it is always legal except when explicitly policy-gated.

## Operation restrictions

Lifecycle class restricts operation kinds. Space containment also restricts
operation kinds.

| Lifecycle class | Create/update/delete  | Verify/observe | Link/materialize | Revoke generated child  |
| --------------- | --------------------- | -------------- | ---------------- | ----------------------- |
| managed         | yes                   | yes            | yes              | yes                     |
| generated       | by owner operation    | yes            | yes              | yes                     |
| external        | no                    | yes            | yes              | generated children only |
| operator        | no by user deployment | yes            | policy-gated     | generated children only |
| imported        | policy-gated          | yes            | yes              | generated children only |
