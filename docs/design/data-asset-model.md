# DataAsset Model

DataAsset represents content or input used by Objects and Operations. DataAsset visibility is Space-scoped unless operator artifact policy explicitly shares it.

## v1 scope

Public v1 supports:

```text
prebuilt artifact reference
opaque source archive
operator-approved transform
```

Public v1 does not support arbitrary user shell builds or automatic runtime secret injection into transforms.

## DataAsset kinds

```yaml
DataAsset:
  spaceId: space:acme-prod
  id: asset:...
  kind: oci-image | js-module | wasm-module | static-archive | source-archive
  digest: sha256:...
  uri: optional
  source: optional
```

`source-archive` is opaque by default in v1. Its digest is the archive bytes. Canonical source-tree packaging can be added later without changing the root model.

## Artifact resolution

Local paths are unresolved authoring inputs. Before apply, they must become content-addressed DataAsset records.

```text
with.artifact.path
  -> DataAsset digest

with.source.path
  -> source-archive DataAsset digest
```

## Transform

Transform is an operator-approved operation.

```text
source-archive -> js-module
source-archive -> static-archive
```

Transform operations must not receive runtime secrets unless explicitly approved by policy.

## Accepted asset verification

Plan must verify all relevant layers:

```text
ObjectTarget accepted data asset kinds
selected implementation accepted data asset kinds
connector accepted data asset kinds
artifact policy limits
```

## Space visibility

A DataAsset may be globally stored but is not globally visible by default. `ResolutionSnapshot` records the DataAsset references visible to the Space. Cross-space artifact reuse requires operator artifact policy and must be recorded in resolution.
