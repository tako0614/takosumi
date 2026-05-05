# DataAsset Model

DataAsset represents content or input used by Objects and Operations. DataAsset
visibility is Space-scoped unless operator artifact policy explicitly shares it.

## v1 scope

Public v1 supports:

```text
prebuilt artifact reference
content-addressed artifact upload
operator-registered artifact kind discovery
```

Public v1 does not support arbitrary user shell builds or automatic runtime
secret injection into transforms. Source transforms are spec-reserved until the
matching operator APIs, approval flow, and tests exist.

## DataAsset kinds

```yaml
DataAsset:
  spaceId: space:acme-prod
  id: asset:...
  kind: string # bundled: oci-image | js-bundle | lambda-zip | static-bundle | wasm
  digest: sha256:...
  uri: optional
  source: optional
```

`kind` is open at the protocol layer and discoverable through
`registerArtifactKind` / `GET /v1/artifacts/kinds`. The bundled registry starts
with `oci-image`, `js-bundle`, `lambda-zip`, `static-bundle`, and `wasm`.

## Connector contract

A connector is the operator-installed binding that brings DataAsset bytes into
reach of an implementation. Connectors are not user-named in the public
manifest; they are referenced by the implementation chosen during resolution.

```yaml
Connector:
  id: connector:cloudflare-workers-bundle # connector:<id>, operator-controlled
  acceptedKinds: [js-bundle]
  spaceVisibility: operator-policy-driven # which Spaces may use this connector
  signingExpectations: optional # signature / digest requirements
```

Identity rules:

- Connectors are addressed as `connector:<id>`. The id is operator-controlled
  and never selected by the user manifest.
- Each connector declares an `acceptedKinds` vector drawn from the DataAsset
  kinds enum above. Plan must reject a Link / DataAsset binding whose kind is
  not in the connector's accepted vector.
- Connector visibility is Space-scoped through operator policy. A connector
  visible in one Space is not implicitly visible in another; see
  [Operator Boundaries](./operator-boundaries.md).
- Connectors are never installed, replaced, or revoked through the public
  manifest path; they enter via operator surfaces only.

## Artifact Resolution

Local files are not sent to the kernel by path. The operator uploads bytes first
and embeds the returned digest in the manifest.

```text
takosumi artifact push ./worker.js --kind js-bundle
  -> { hash: sha256:..., kind: js-bundle }

resources[].spec.artifact.hash
  -> DataAsset digest visible to the selected Space
```

## Transform (Spec-Reserved)

Transform is an operator-approved operation reserved for a future operator
surface.

```text
source archive -> js-bundle
source archive -> static-bundle
```

Transform operations must not receive runtime secrets unless explicitly approved
by policy.

### Transform approval enforcement

Transform approval is enforced in the `pre-commit` stage of the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md).
The pre-commit hook re-validates the approval that authorized the transform; any
approval invalidation trigger from
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
fails the operation closed before any external transform call begins.

The Risk surfaced when a transform reaches `pre-commit` without a valid approval
is `transform-unapproved`.

## Accepted asset verification

Plan must verify all relevant layers:

```text
ObjectTarget accepted data asset kinds
selected implementation accepted data asset kinds
connector accepted data asset kinds
artifact policy limits
```

## Space visibility

A DataAsset may be globally stored but is not globally visible by default.
`ResolutionSnapshot` records the DataAsset references visible to the Space.
Cross-space artifact reuse requires operator artifact policy and must be
recorded in resolution.
