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
  sourceObservationDigest: sha256:...   # latest observation feeding `health`
```

`sourceObservationDigest` records the ObservationSet entry that produced
the current `health` annotation; it is the only authoritative link from
runtime reality back to the snapshot. ObservationSet entries do not
mutate `assignments`.

GroupHead moves only after apply-phase revalidation and activation policy pass.

## Post-activate health state

After activation, an exposure tracks runtime reality through a closed v1
state machine. Transitions are driven only by entries appended to
ObservationSet by the `observe` stage of the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md).
No transition mutates DesiredSnapshot.

```text
unknown → observing → healthy
                 \ → degraded
                 \ → unhealthy

healthy   ↔ degraded ↔ unhealthy   (re-entry on observation change)
```

| state | meaning |
| --- | --- |
| `unknown` | no observation recorded yet (pre-first-probe) |
| `observing` | a probe is in flight |
| `healthy` | latest observation confirms the desired assignment |
| `degraded` | partial signal; some checks pass, some fail |
| `unhealthy` | latest observation contradicts the desired assignment |

Effects of `unhealthy`:

- `unhealthy` does not rewrite DesiredSnapshot. It only feeds DriftIndex
  and an annotation on ActivationSnapshot.
- `unhealthy` blocks new traffic shifts initiated by future activations
  unless an approval explicitly overrides; existing GroupHead pointers
  are not rolled back automatically (fail-safe-not-fail-closed).
- See [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
  for how drift entries are produced from this state.
