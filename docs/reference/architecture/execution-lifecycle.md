# 実行ライフサイクル {#execution-lifecycle}

This page is reference implementation architecture. The portable public contract
remains AppSpec / Installation / Deployment plus the Installer API.
OperationPlan, dry materialization, Approval records, snapshots, and journals
are internal/operator execution concepts.

Execution は Space scope であり、snapshot に裏付けられ、journal される。

## プレビュー / 解決 {#preview--resolve}

```text
1. determine Space from actor auth / API path / operator context
2. parse AppSpec into IntentGraph
3. resolve component kinds through Space-visible aliases, descriptors, and implementation bindings
4. resolve Space-scoped external publications and optional operator DataAsset extension requirements
5. create ResolutionSnapshot
6. create DesiredSnapshot
7. derive OperationPlan
8. show summary / risk / details
```

Preview は provider / resource / materialization side effect を持たず、
Installation / Deployment record も作りません。audit、telemetry、rate-limit
accounting event は emit できます。

## Apply {#apply}

この phase は
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
で定義された WAL stage を進行する。

```text
prepare      load immutable ResolutionSnapshot and DesiredSnapshot;
             derive OperationPlan from current ObservationSet
	pre-commit   revalidate operator-issued scoped installer context / policy snapshot,
	             kind descriptor / implementation binding availability,
	             publication freshness, approvals (including the predicted effect
             digest), optional DataAsset extension availability; raise Risks;
             fail closed on any invalidation
commit       record operation intent and execute operations through
             implementations; append generated object handles
post-commit  append actual effects; compensate or queue RevokeDebt on
             failure
finalize     persist retained evidence and candidate activation intent
```

## Activate {#activate}

```text
prepare      revalidate activation requirements
commit       reserve / update traffic assignments
post-commit  update Space-local GroupHead under production serialization
observe      record active exposure health into ObservationSet
```

## Destroy {#destroy}

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

## ロールバックと回復 {#rollback-and-recovery}

```text
public rollback:
  move Installation.currentDeploymentId to a retained succeeded Deployment and
  reactivate that Deployment's public/non-secret outputs; do not create a new
  Deployment

reference implementation rollback:
  update the internal routing / activation pointers needed to serve the selected
  Deployment

recovery:
  resume or compensate an unfinished WAL entry after restart / lock re-acquire

repair / new deploy:
  re-resolve old intent against current Space-visible kind descriptor /
  implementation binding set; this is not rollback

data restore:
  operator / app data-protection workflow separate from pointer rollback
```

`POST /v1/installations/{id}/rollback` は public rollback だけを実行します。過去
Deployment の recorded source / snapshot / evidence を authority とし、現在の
descriptor や external publication を再解決しません。re-resolve が必要な場合は
repair または new Deployment として記録します。

## Internal dry materialization and approval carry {#internal-dry-materialization-and-approval-carry}

This section describes an operator/reference-kernel approval implementation. The
core dry-run response remains `changes[]` plus `expected`; account-plane
approval prompts, prediction digests, approval tokens, and risk summaries are
operator extension fields or account-plane API records.

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
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
の `pre-commit` stage で fail-closed する。新しい prediction で承認サイクルを
やり直す必要がある。

## 本番並行性 {#production-concurrency}

本番は次の operation を Space 内で直列化しなければならず、global ingress の
予約は operator-global の直列化も必要としうる。

```text
GroupHead update
ActivationSnapshot update
ingress reservation
generated credential mutation
generated grant mutation
external publication registry writes
Space publication sharing
kind alias / descriptor / implementation binding set updates
```
