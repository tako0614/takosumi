# Snapshot Model

> このページでわかること: snapshot モデルとバージョニングの仕組み。

snapshot は Space scope の immutable な authority record である。

## IntentGraph

IntentGraph is parsed authoring intent plus deploy context. It carries
`spaceId`, but the manifest itself does not.

It contains:

```text
declared Shape resource intents
provider ids
template expansion provenance
resource dependency refs
link intents derived from Shape-defined bindings
exposure intents derived from route-bearing resources
data asset intents from resource specs
space id from deploy context
```

IntentGraph is not authority for apply.

## ResolutionSnapshot

ResolutionSnapshot records what the kernel believed.

```yaml
ResolutionSnapshot:
  id: resolution:...
  spaceId: space:...
  catalogReleaseId: catalog-release-...
  descriptorClosureDigest: sha256:...
  namespaceSnapshotDigest: sha256:...
  namespaceScopeStackDigest: sha256:...
  selectedTargets: []
  selectedExports: []
  selectedProjections: []
  selectedImplementations: []
  spaceExportShares: []
  policyDecisions: []
  approvals: []
  dataAssetRequirements: []
```

ResolutionSnapshot includes:

- Space id and namespace scope stack
- CatalogRelease id and registry digests
- descriptor closure and input schema digests
- ExportDeclaration snapshots with Space scope and provenance
- selected ObjectTargets
- selected projections and access surfaces
- selected implementations
- policy decisions and approval bindings
- data asset requirements

## DesiredSnapshot

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
  dataAssetRefs: []
```

DesiredSnapshot is immutable.

## OperationPlan

OperationPlan is derived from DesiredSnapshot and current ObservationSet. It is
not canonical desired state.

## OperationJournal

OperationJournal records what was attempted, generated, failed, compensated, or
left as debt.

## ObservationSet

ObservationSet records current facts. It does not update snapshots.

## ActivationSnapshot

ActivationSnapshot records active traffic, rollout state, and current assignment
inside one Space. GroupHead points to the current activation/deployment state
for `spaceId + groupId`.
