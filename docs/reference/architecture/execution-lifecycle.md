# 実行ライフサイクル {#execution-lifecycle}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

OperationPlan、dry materialization、Approval record、snapshot、journal は internal / operator の実行概念です。

Execution は Space scope であり、snapshot に裏付けられ、journal される。

## プレビュー / 解決 {#preview--resolve}

```text
1. determine Space from actor auth / API path / operator context
2. resolve Source into an InstallPlan snapshot
3. resolve implementation bindings through operator inventory and recorded PlatformService selection
4. resolve Space-scoped platform services and optional operator asset extension requirements
5. create ResolvedPlan
6. create TargetState
7. derive OperationPlan
8. show summary / risk / details
```

Preview は backend / resource / materialization side effect を持たず、Installation / Deployment record も作りません。audit、telemetry、rate-limit accounting event は emit できます。

## Apply {#apply}

この phase は [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal) で定義された WAL stage を進行する。

```text
prepare      load immutable ResolvedPlan and TargetState;
             derive OperationPlan from current ObservationState
	pre-commit   revalidate operator-issued scoped installer context / policy snapshot,
	             kind schema / binding availability,
	             platform service freshness, approvals (including the predicted effect
             digest), optional asset extension availability; raise Risks;
             fail closed on any invalidation
commit       record operation intent and execute operations through
             implementations; append generated object handles
post-commit  append actual effects; compensate or queue CleanupBacklog on
             failure
finalize     persist retained evidence and candidate activation intent
```

## Activate {#activate}

```text
prepare      revalidate activation requirements
commit       reserve / update traffic assignments
post-commit  update Space-local RoutingPointer under production serialization
observe      record active exposure health into ObservationState
```

## Destroy {#destroy}

```text
prepare      load TargetState; identify managed / generated objects
             owned by the snapshot
pre-commit   revalidate that destroy is permitted by lifecycle class and
             Space policy
commit       revoke or delete managed objects and link-owned generated
             material; never destroy external source objects
post-commit  queue CleanupBacklog where external cleanup did not complete
finalize     TrafficSnapshot is updated to reflect the destroy
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
  re-resolve old intent against current Space-visible kind schema /
  binding set; this is not rollback

data restore:
  operator / app data-protection workflow separate from pointer rollback
```

`POST /v1/installations/{id}/rollback` は public rollback だけを実行します。過去 Deployment の recorded source / snapshot / evidence を authority とし、現在の kind の定義や platform service を再解決しません。re-resolve が必要な場合は repair または new Deployment として記録します。

## Internal dry materialization and approval carry {#internal-dry-materialization-and-approval-carry}

このセクションは operator / Takosumi service の approval 実装を記述します。Takosumi v1 の dry-run response は `changes[]` と `expected` に留まります。account layer の approval prompt、prediction digest、approval token、risk summary は operator extension field または account layer API record です。

resolution が `require-approval` Risk を surface したとき、reference Takosumi / operator の approval 設定は **dry-materialized prediction** を生成し、承認者に同意を求める effect digest を捕捉する。

```text
expectedEffectsDigest:
  sha256 over the predicted operation effects, computed without any
  external call

predictedGeneratedObjectIds:
  the deterministic ids the apply will create

predictedCleanupBacklogPreview:
  any CleanupBacklog that an apply would queue if external cleanup fails
```

prediction digest は Approval record に bind される。

```yaml
Approval:
  expectedEffectsDigest: sha256:...
  effectDetailsDigest: sha256:...
  operationPlanDigest: sha256:...
  desiredSnapshotDigest: sha256:...
```

次の apply は一致する prediction digest を観測しなければならない。承認と apply の間に [Approval invalidation trigger](./approval-model.md) のいずれかが発火した場合、prediction digest は一致せず approval は無効化され、 apply は [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal) の `pre-commit` stage で fail-closed する。新しい prediction で承認サイクルをやり直す必要がある。

## 本番並行性 {#production-concurrency}

本番は次の operation を Space 内で直列化しなければならず、global ingress の予約は operator-global の直列化も必要としうる。

```text
RoutingPointer update
TrafficSnapshot update
ingress reservation
generated credential mutation
generated authorization mutation
platform service registry writes
future cross-Space service sharing policy
descriptor / implementation binding set updates
```
