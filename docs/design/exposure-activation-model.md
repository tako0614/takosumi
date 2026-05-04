# Exposure and Activation Model

`expose` creates Exposure intent inside one Space. It is not a Link.

## Exposure

```yaml
Exposure:
  spaceId: space:acme-prod
  id: exposure:web
  from: object:api
  host: app.example.com
  path: /
  protocol: https
```

Exposure prepares external ingress. It does not by itself make the deployment current.

## Apply vs activation

```text
apply:
  prepare objects, links, generated grants, generated credentials, exposure material

activate:
  update traffic assignment, activation snapshot, and Space-local GroupHead

post-activate observe:
  verify route health and active assignment
```


## Space rule

Exposure ownership, ingress reservation, route materialization, ActivationSnapshot, and GroupHead are Space-local. Two Spaces may not claim the same global ingress unless the operator route policy allows shared ownership or delegation.

```text
GroupHead identity = spaceId + groupId
```

Cross-space traffic assignment is not part of public v1.

## Exposure generated objects

Exposure materialization may create generated objects:

```text
IngressReservation
DnsMaterialization
TlsMaterialization
ProviderIngressObject
TrafficAssignment
```

Each generated object has owner, reason, deterministic id, and delete policy.

```yaml
GeneratedObject:
  owner: exposure:web
  reason: tls-materialization
  deletePolicy: delete-with-owner | retain-with-approval
```

## ActivationSnapshot

```yaml
ActivationSnapshot:
  id: activation:...
  desiredSnapshotId: desired:...
  assignments: []
  activatedAt: ...
  health: pending | healthy | degraded | failed
```

GroupHead moves only after apply-phase revalidation and activation policy pass.
