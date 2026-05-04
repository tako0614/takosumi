# Execution Lifecycle

Execution is Space-scoped, snapshot-backed, and journaled.

## Preview / resolve

```text
1. determine Space from actor auth / API path / operator context
2. parse manifest into IntentGraph
3. select a CatalogRelease allowed for the Space
4. resolve targets, Space-scoped namespace exports, data asset requirements
5. create ResolutionSnapshot
6. create DesiredSnapshot
7. derive OperationPlan
8. show summary / risk / details
```

Preview has no side effects.

## Apply

```text
1. load immutable ResolutionSnapshot and DesiredSnapshot for the Space
2. revalidate Space membership, catalog release availability, export freshness, approvals, Space export shares, and data asset availability
3. derive OperationPlan from current ObservationSet
4. record operation intent in WriteAheadOperationJournal
5. execute operations through implementations
6. append generated object handles and actual effects
7. compensate or create debt on failure
8. observe
9. prepare ActivationSnapshot
```

## Activate

```text
1. revalidate activation requirements
2. reserve / update traffic assignments
3. update Space-local GroupHead under production serialization
4. observe active exposure health
```

## Destroy

Destroy removes managed and generated objects owned by the DesiredSnapshot. It does not destroy external source objects. Link-owned generated grants, credentials, endpoints, and projections are revoked or deleted. Revoke failure creates RevokeDebt.

## Rollback and recovery

```text
strict rollback:
  use old ResolutionSnapshot and DesiredSnapshot exactly; fail if unusable

revalidated rollback:
  use old DesiredSnapshot; revalidate external exports, artifacts, implementations, ingress ownership

re-resolved recovery:
  re-resolve old intent against current CatalogRelease; not called rollback
```

## Production concurrency

Production must serialize these operations within a Space, and global ingress reservation may also require operator-global serialization:

```text
GroupHead update
ActivationSnapshot update
ingress reservation
generated credential mutation
generated grant mutation
namespace registry writes
Space export sharing
CatalogRelease activation and Space assignment
```
