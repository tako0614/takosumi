# Snapshot モデル {#snapshot-model}

This page describes reference implementation retained evidence. Portable
Takosumi compatibility remains AppSpec / Installation / Deployment plus the
Installer API; snapshot records are not public core entities.

snapshot は Space scope の immutable な internal evidence record である。

## IntentGraph {#intentgraph}

IntentGraph is parsed authoring intent plus deploy context. It carries `spaceId`
from the deploy context.

It contains:

```text
declared component intents (= AppSpec components[*].kind)
Space-visible kind alias / descriptor provenance
AppSpec publish/listen edge dependency provenance
link intents derived from component kind publish/listen bindings
exposure intents derived from kind-specific specs
optional operator DataAsset extension requirements / refs resolved by operator policy, kind descriptor, provider binding, or connector binding
space id from deploy context
```

ResolutionSnapshot is the reference implementation apply evidence. Public apply
authority is the Installer API result and the resulting Deployment record.

## ResolutionSnapshot {#resolutionsnapshot}

ResolutionSnapshot records the operator/reference resolution evidence used for
one Deployment.

```yaml
ResolutionSnapshot:
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

Reference-kernel storage may include descriptor-closure records and adapter ids
inside its implementation evidence. The public model needs stable resolution
evidence; the storage shape can differ across compatible implementations.

## DesiredSnapshot {#desiredsnapshot}

```yaml
DesiredSnapshot:
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

OperationPlan は DesiredSnapshot と現在の ObservationSet から生成される provider
operation の実行計画です。OperationPlan は canonical desired state ではなく、
「DesiredSnapshot を実現するために何を実行するか」を記録する transient plan
です。各 operation は create / update / delete / noop のいずれかで、WAL に書き
込んでから実行されます。

詳細は [Runtime Deployment Model](./runtime-deployment-model.md) を参照。

## OperationJournal {#operationjournal}

OperationJournal は実行の trial record です。各 WAL entry には何を試み、何が
生成され、何が失敗し、何が compensated（取り消し済み）で、何が debt として残って
いるかが記録されます。compensation 後も journal entry は削除されず、audit log
として残ります。

詳細は [WAL Stages](../wal-stages.md) を参照。

## ObservationSet {#observationset}

ObservationSet は activate 後の runtime reality を追跡する observation entry の
集合です。readiness probe / health check / drift detection の結果が entry として
append されます。ObservationSet は DesiredSnapshot を変更しません。snapshot の
更新は新しい ResolutionSnapshot / ActivationSnapshot record を通じて行われます。

詳細は [Observation Retention](../observation-retention.md) を参照。

## ActivationSnapshot {#activationsnapshot}

ActivationSnapshot は active traffic assignment、rollout state、current
assignment を Space 内に記録します。GroupHead は `spaceId + groupId` ごとの
current activation state を指す pointer です。activation が成功すると、
Deployment id と split / shadow assignment を含む ActivationSnapshot が記録さ
れ、GroupHead がそこを指すように更新されます。

詳細は [Exposure Activation モデル](./exposure-activation-model.md) と
[GroupHead Rollout](../group-head-rollout.md) を参照。

## Snapshot 間の依存関係 {#snapshot-dependencies}

```text
IntentGraph
  → ResolutionSnapshot    (= kernel が何を信じたか)
    → DesiredSnapshot     (= kernel が何を実現したいか)
      → OperationPlan     (= 実行計画)
        → WAL             (= 実行 journal)
          → ObservationSet (= runtime reality の観測)
            → ActivationSnapshot (= active traffic assignment)
              → GroupHead  (= current pointer)
```
