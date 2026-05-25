# Snapshot モデル {#snapshot-model}

::: info 内部設計メモ
public contract は [Installer API](../installer-api.md) を参照。
:::

snapshot は Space scope の immutable な internal evidence record である。

## IntentGraph {#intentgraph}

IntentGraph は parse 済みの authoring intent と deploy context です。deploy
context から `spaceId` を持ちます。

含まれる内容:

```text
declared component intents (= manifest components[*].kind)
Space-visible kind alias / descriptor provenance
manifest publish/listen edge dependency provenance
link intents derived from component kind publish/listen bindings
exposure intents derived from kind-specific specs
optional operator asset extension requirements / refs resolved by operator policy, kind schema, provider binding, or connector binding
space id from deploy context
```

ResolvedPlan は reference implementation の apply evidence です。public な apply
authority は Installer API の結果と、その結果の Deployment record です。

## ResolvedPlan {#resolutionsnapshot}

ResolvedPlan は 1 つの Deployment に使われた operator / reference resolution
evidence を記録します。

```yaml
ResolvedPlan:
  id: res_...
  spaceId: space:...
  resolutionEvidenceDigest: sha256:...
  externalPublicationSnapshotDigest: sha256:...
  publicationScopeDigest: sha256:...
  selectedCatalogEntries: []
  selectedPublications: []
  selectedProjections: []
  selectedImplementations: []
  operatorResolutionEvidence: []
  spacePublicationShares: []
  policyDecisions: []
  approvals: []
  dataAssetExtensionRequirements: []
```

Reference Takosumi の storage は implementation evidence 内に kind の定義の
closure record や adapter id を含みうります。public model には安定した resolution
evidence が必要ですが、storage shape は互換実装ごとに異なりえます。

## TargetState {#desiredsnapshot}

```yaml
TargetState:
  id: desired:...
  spaceId: space:...
  resolutionSnapshotId: res_...
  objects: []
  publications: []
  links: []
  exposures: []
  runtimePolicies: []
  activationRequirements: []
  dataAssetExtensionRefs: []
```

## OperationPlan {#operationplan}

OperationPlan は TargetState と現在の ObservationState から生成される
リソースの作成・更新の実行計画です。OperationPlan は canonical desired state ではなく、
「TargetState を実現するために何を実行するか」を記録する transient plan
です。各 operation は create / update / delete / noop のいずれかで、WAL に書き
込んでから実行されます。

詳細は [Runtime Deployment Model](./runtime-deployment-model.md) を参照。

## OperationJournal {#operationjournal}

OperationJournal は実行の trial record です。各 WAL entry には何を試み、何が
生成され、何が失敗し、何が compensated（取り消し済み）で、何が debt として残って
いるかが記録されます。compensation 後も journal entry は削除されず、audit log
として残ります。

詳細は [WAL Stages](../wal-stages.md) を参照。

## ObservationState {#observationset}

ObservationState は activate 後の runtime reality を追跡する observation entry の
集合です。readiness probe / health check / drift detection の結果が entry として
append されます。ObservationState は TargetState を変更しません。snapshot の
更新は新しい ResolvedPlan / TrafficSnapshot record を通じて行われます。

詳細は [Observation Retention](../observation-retention.md) を参照。

## TrafficSnapshot {#activationsnapshot}

TrafficSnapshot は active traffic assignment、rollout state、current
assignment を Space 内に記録します。RoutingPointer は `spaceId + groupId` ごとの
current activation state を指す pointer です。activation が成功すると、
Deployment id と split / shadow assignment を含む TrafficSnapshot が記録さ
れ、RoutingPointer がそこを指すように更新されます。

詳細は [Exposure Activation モデル](./ingress-routing.md) と
[RoutingPointer Rollout](../group-head-rollout.md) を参照。

## Snapshot 間の依存関係 {#snapshot-dependencies}

```text
IntentGraph
  → ResolvedPlan    (= Takosumi が何を信じたか)
    → TargetState     (= Takosumi が何を実現したいか)
      → OperationPlan     (= 実行計画)
        → WAL             (= 実行 journal)
          → ObservationState (= runtime reality の観測)
            → TrafficSnapshot (= active traffic assignment)
              → RoutingPointer  (= current pointer)
```
