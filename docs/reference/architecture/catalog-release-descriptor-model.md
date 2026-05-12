# Catalog Release and Descriptor Model

Takosumi uses distributed descriptors, but live descriptor web is not runtime
authority. Runtime authority comes from a `CatalogRelease` adopted by the
operator and allowed for the Space that is resolving the deployment.

## Descriptor source vs runtime authority

```text
Descriptor documents:
  upstream semantic source, often JSON-LD

Catalog ingestion:
  fetch, validate, normalize, pin contexts, compute digest, apply trust policy

CatalogRelease:
  adopted semantic and implementation world

ResolutionSnapshot:
  deployment-specific fixed semantic snapshot inside one Space
```

JSON-LD is an ingestion format, not the kernel runtime reasoning engine. Kernel
runtime uses normalized descriptor records.

## CatalogRelease

A CatalogRelease is atomic.

```yaml
CatalogRelease:
  releaseId: catalog-release-2026-05-04.1
  descriptorRegistryDigest: sha256:...
  namespaceRegistryDigest: sha256:...
  spaceRegistryDigest: sha256:...
  implementationRegistryDigest: sha256:...
  profileRegistryDigest: sha256:...
  trustPolicyDigest: sha256:...
  deploymentPolicyDigest: sha256:...
  artifactPolicyDigest: sha256:...
  spacePolicyDigest: sha256:...
  protocolEquivalencePolicyDigest: sha256:...
  createdAt: "2026-05-04T00:00:00Z"
  activatedAt: "2026-05-04T00:10:00Z"
```

Resolution uses exactly one CatalogRelease allowed by the current Space. Apply
uses the CatalogRelease recorded in `ResolutionSnapshot`. CatalogRelease
activation and Space assignment are serialized operator operations. The registry
domain now implements the primitive pieces for this boundary: publisher key
enrollment/revocation, Ed25519 signature verification of the canonical
descriptor payload, signed descriptor persistence, and append-only per-Space
adoption records. Public OperationPlan WAL invokes CatalogRelease
re-verification during pre/post-commit: pre-commit verification fails closed
before provider side effects, and post-commit verification failure is journaled
with RevokeDebt for committed effects. Catalog-declared executable hook packages

## Space assignment

A CatalogRelease is not automatically visible to every Space. Operator policy
assigns releases to Spaces.

```yaml
SpaceCatalogAssignment:
  spaceId: space:acme-prod
  defaultCatalogReleaseId: catalog-release-2026-05-04.1
  allowedCatalogReleaseIds:
    - catalog-release-2026-05-04.1
  policyPack: prod/strict
```

A deployment may resolve only against a release allowed for its Space.

## Catalog registries

The operator catalog is implemented as separate registries.

```text
Target Registry:
  target alias -> ObjectTarget descriptor

Descriptor Registry:
  descriptor URL -> normalized descriptor, digest, source context digests

Space Registry:
  space id -> allowed catalog releases, namespace visibility, secret/artifact partitions, policy pack

Namespace Registry:
  space-scoped namespace export path -> ExportDeclaration snapshot

Implementation Registry:
  operation capability -> implementation

Profile Registry:
  abstract target and projection preferences

Trust Policy:
  allowed descriptor issuers and compatibility publishers

Protocol Equivalence Policy:
  operator-approved protocol equivalence

Deployment Policy:
  allow / deny / approval defaults

Artifact Policy:
  accepted data asset modes and limits
```

## Descriptor documents

Descriptors define semantic data only. They do not carry executable code.

Descriptor families:

```text
ObjectTarget
NamespaceExport
Protocol
AccessSurface
Compatibility
DataAssetKind
InputSchema
```

Implementation packaging is not part of descriptor identity.

## Descriptor digest

A descriptor identity used in snapshots is:

```text
descriptor URL + normalized descriptor digest + normalized context digests
```

## Production rule

Public v1 manifests reference catalog aliases. Direct descriptor URL usage may
exist in self-host development or catalog ingestion, but not as default public
v1 syntax.
