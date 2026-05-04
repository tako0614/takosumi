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

## Connector contract

A connector is the operator-installed binding that brings DataAsset bytes
into reach of an implementation. Connectors are not user-named in the
public manifest; they are referenced by the implementation chosen during
resolution.

```yaml
Connector:
  id: connector:cloudflare-workers-bundle   # connector:<id>, operator-controlled
  acceptedKinds: [js-module, static-archive]
  spaceVisibility: operator-policy-driven   # which Spaces may use this connector
  signingExpectations: optional             # signature / digest requirements
```

Identity rules:

- Connectors are addressed as `connector:<id>`. The id is operator-controlled
  and never selected by the user manifest.
- Each connector declares an `acceptedKinds` vector drawn from the
  DataAsset kinds enum above. Plan must reject a Link / DataAsset binding
  whose kind is not in the connector's accepted vector.
- Connector visibility is Space-scoped through operator policy. A
  connector visible in one Space is not implicitly visible in another;
  see [Operator Boundaries](./operator-boundaries.md).
- Connectors are never installed, replaced, or revoked through the public
  manifest path; they enter via operator surfaces only.

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

### Transform approval enforcement

Transform approval is enforced in the `pre-commit` stage of the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md).
The pre-commit hook re-validates the approval that authorized the
transform; any approval invalidation trigger from
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
fails the operation closed before any external transform call begins.

The Risk surfaced when a transform reaches `pre-commit` without a valid
approval is `transform-unapproved`.

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
