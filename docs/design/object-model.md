# Object Model

Object is the canonical entity in the kernel graph. Every Object belongs to exactly one Space. A public manifest component becomes an Object intent, then a resolved Object.


## Space-qualified identity

Object addresses are unique within a Space. Storage should treat identity as a tuple.

```text
(spaceId, objectAddress)
```

Qualified display form is allowed for logs and plans.

```text
space:acme-prod/object:api
```

An Object in one Space must never be updated, deleted, or observed as authority for another Space.

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
  target: cloudflare-workers
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

## Operation restrictions

Lifecycle class restricts operation kinds. Space containment also restricts operation kinds.

| Lifecycle class | Create/update/delete | Verify/observe | Link/materialize | Revoke generated child |
| --- | --- | --- | --- | --- |
| managed | yes | yes | yes | yes |
| generated | by owner operation | yes | yes | yes |
| external | no | yes | yes | generated children only |
| operator | no by user deployment | yes | policy-gated | generated children only |
| imported | policy-gated | yes | yes | generated children only |
