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

The phase walks the WAL stages defined in the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md):

```text
prepare      load immutable ResolutionSnapshot and DesiredSnapshot;
             derive OperationPlan from current ObservationSet
pre-commit   revalidate Space membership, catalog release availability,
             export freshness, approvals (including the predicted
             effect digest), SpaceExportShare state, and data asset
             availability; raise Risks; fail closed on any invalidation
commit       record operation intent and execute operations through
             implementations; append generated object handles
post-commit  append actual effects; compensate or queue RevokeDebt on
             failure
observe      record reality into ObservationSet; queue RevokeDebt for
             external cleanups that did not complete
finalize     prepare ActivationSnapshot
```

## Activate

```text
prepare      revalidate activation requirements
commit       reserve / update traffic assignments
post-commit  update Space-local GroupHead under production serialization
observe      record active exposure health into ObservationSet
```

## Destroy

```text
prepare      load DesiredSnapshot; identify managed / generated objects
             owned by the snapshot
pre-commit   revalidate that destroy is permitted by lifecycle class and
             Space policy
commit       revoke or delete managed objects and link-owned generated
             material; never destroy external source objects
post-commit  queue RevokeDebt where external cleanup did not complete
finalize     ActivationSnapshot is updated to reflect the destroy
```

## Rollback and recovery

```text
strict rollback:
  use old ResolutionSnapshot and DesiredSnapshot exactly; fail if unusable

revalidated rollback:
  use old DesiredSnapshot; revalidate external exports, artifacts, implementations, ingress ownership

re-resolved recovery:
  re-resolve old intent against current CatalogRelease; not called rollback
```

## Dry materialization & approval carry

When resolution surfaces a `require-approval` Risk, the kernel produces a
**dry-materialized prediction** that captures the effect digests an approver is
asked to consent to:

```text
predictedActualEffectsDigest:
  sha256 over the predicted operation effects, computed without any
  external call

predictedGeneratedObjectIds:
  the deterministic ids the apply will create

predictedRevokeDebtPreview:
  any RevokeDebt that an apply would queue if external cleanup fails
```

The prediction digest is bound into the Approval record:

```yaml
Approval:
  predictedActualEffectsDigest: sha256:...
  effectDetailsDigest: sha256:...
  operationPlanDigest: sha256:...
  desiredSnapshotDigest: sha256:...
```

The next apply must observe a matching prediction digest. If any of the
[Approval invalidation triggers](./policy-risk-approval-error-model.md) fire
between approval and apply, the prediction digest will not match and the
approval is invalidated; apply fails closed at the `pre-commit` stage of the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md).
A new approval cycle must run with the new prediction.

## Production concurrency

Production must serialize these operations within a Space, and global ingress
reservation may also require operator-global serialization:

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
