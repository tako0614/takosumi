# Catalog Release and Descriptor Model

> このページでわかること: CatalogRelease と Descriptor のデータモデル。

Takosumi は分散 descriptor を使うが、生きた descriptor web は runtime authority
ではない。runtime authority は operator が adopt し、 deployment を resolve する
Space に許可された `CatalogRelease` から来る。

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

JSON-LD は ingestion 形式であり、kernel runtime の推論エンジンではない。kernel
runtime は normalize 済みの descriptor record を使う。

## CatalogRelease

CatalogRelease は atomic である。

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

Resolution は現在の Space に許可された 1 つの CatalogRelease を使う。Apply は
`ResolutionSnapshot` に記録された CatalogRelease を使う。CatalogRelease の
activation と Space assignment は直列化された operator 操作である。v1 の trust
は **operator-pinned digest** (sha256) であり、publisher signing
ではない。operator は kernel host config に `CATALOG_DIGEST` を pin し、kernel
は TLS で catalog を fetch して sha256 を検証し、得られた digest を append-only
な per-Space adoption record に永続化する。Public OperationPlan WAL は
pre/post-commit で CatalogRelease の再検証を行う。pre-commit verification は
provider side effect の前に fail-closed で失敗し、post-commit verification
の失敗は commit 済み effect に対して RevokeDebt 付きで journal される。動的
registry / multi-mirror の用途には将来 RFC で publisher-signing domain
が追加されうるが、v1 の一部ではない (詳細は
[Supply Chain Trust § 6](../supply-chain-trust.md#_6-catalog-release-trust))。
catalog 宣言された実行可能 hook package。

## Space assignment

CatalogRelease は自動的にすべての Space から見えるわけではない。operator policy
が release を Space に割り当てる。

```yaml
SpaceCatalogAssignment:
  spaceId: space:acme-prod
  defaultCatalogReleaseId: catalog-release-2026-05-04.1
  allowedCatalogReleaseIds:
    - catalog-release-2026-05-04.1
  policyPack: prod/strict
```

deployment は自身の Space に許可された release に対してのみ resolve できる。

## Catalog registries

operator catalog は複数の registry に分割して実装される。

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

Descriptor は semantic data のみを定義する。実行可能コードは持たない。

Descriptor family:

```text
ObjectTarget
NamespaceExport
Protocol
AccessSurface
Compatibility
DataAssetKind
InputSchema
```

Implementation packaging は descriptor identity の一部ではない。

## Descriptor digest

snapshot で使う descriptor identity は次の組合せ:

```text
descriptor URL + normalized descriptor digest + normalized context digests
```

## Production rule

Public v1 manifest は catalog alias を参照する。self-host 開発や catalog
ingestion で descriptor URL を直接参照することはあり得るが、 public v1
のデフォルト構文ではない。
