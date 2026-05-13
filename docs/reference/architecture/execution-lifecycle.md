# Execution Lifecycle

> このページでわかること: deployment 実行のライフサイクルとステート遷移。

Execution は Space scope であり、snapshot に裏付けられ、journal される。

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

Preview に副作用はない。

## Apply

この phase は
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
で定義された WAL stage を進行する。

```text
prepare      load immutable ResolutionSnapshot and DesiredSnapshot;
             derive OperationPlan from current ObservationSet
pre-commit   revalidate Space membership, catalog release availability,
	             export freshness, approvals (including the predicted
	             effect digest), data asset
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

resolution が `require-approval` Risk を surface したとき、kernel は
**dry-materialized prediction** を生成し、承認者に同意を求める effect digest
を捕捉する。

```text
predictedActualEffectsDigest:
  sha256 over the predicted operation effects, computed without any
  external call

predictedGeneratedObjectIds:
  the deterministic ids the apply will create

predictedRevokeDebtPreview:
  any RevokeDebt that an apply would queue if external cleanup fails
```

prediction digest は Approval record に bind される。

```yaml
Approval:
  predictedActualEffectsDigest: sha256:...
  effectDetailsDigest: sha256:...
  operationPlanDigest: sha256:...
  desiredSnapshotDigest: sha256:...
```

次の apply は一致する prediction digest を観測しなければならない。承認と apply
の間に [Approval invalidation trigger](./policy-risk-approval-error-model.md) の
いずれかが発火した場合、prediction digest は一致せず approval は無効化され、
apply は
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
の `pre-commit` stage で fail-closed する。新しい prediction で承認サイクルを
やり直す必要がある。

## Production concurrency

本番は次の operation を Space 内で直列化しなければならず、global ingress の
予約は operator-global の直列化も必要としうる。

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
