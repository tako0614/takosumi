# Snapshot モデル {#snapshot-model}

> このページでわかること: snapshot モデルとバージョニングの仕組み。

snapshot は Space scope の immutable な authority record である。

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
optional operator DataAsset extension intents from kind-specific specs
space id from deploy context
```

ResolutionSnapshot is the apply authority.

## ResolutionSnapshot {#resolutionsnapshot}

ResolutionSnapshot records what the kernel believed.

```yaml
ResolutionSnapshot:
  id: resolution:...
  spaceId: space:...
  kindDescriptorClosureDigest: sha256:...
  namespaceSnapshotDigest: sha256:...
  namespaceScopeStackDigest: sha256:...
  selectedKindDescriptors: []
  selectedAdapters: []
  selectedExports: []
  selectedProjections: []
  selectedImplementations: []
  spaceExportShares: []
  policyDecisions: []
  approvals: []
  dataAssetExtensionRequirements: []
```

ResolutionSnapshot includes:

- Space id and namespace scope stack
- kind alias resolution, descriptor closure, and input schema digests
- ExportDeclaration snapshots with Space scope and provenance
- selected provider implementations
- selected projections and access surfaces
- policy decisions and approval bindings
- optional operator DataAsset extension requirements

## DesiredSnapshot {#desiredsnapshot}

DesiredSnapshot records what the kernel intends to exist.

```yaml
DesiredSnapshot:
  id: desired:...
  spaceId: space:...
  resolutionSnapshotId: resolution:...
  objects: []
  exports: []
  links: []
  exposures: []
  runtimePolicies: []
  activationRequirements: []
  dataAssetExtensionRefs: []
```

DesiredSnapshot is immutable.

## OperationPlan {#operationplan}

OperationPlan is derived from DesiredSnapshot and current ObservationSet. It is
not canonical desired state.

## OperationJournal {#operationjournal}

OperationJournal records what was attempted, generated, failed, compensated, or
left as debt.

## ObservationSet {#observationset}

ObservationSet records current facts. Snapshot updates flow through new
ResolutionSnapshot / ActivationSnapshot records.

## ActivationSnapshot {#activationsnapshot}

ActivationSnapshot records active traffic, rollout state, and current assignment
inside one Space. GroupHead points to the current activation/deployment state
for `spaceId + groupId`.
