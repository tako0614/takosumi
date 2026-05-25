# Platform Service モデル {#platform-service-model}

Operator platform service compatibility model: [Platform Services](../external-publications.md).

Platform service は publication path で参照できる usable surface です。 publication path は Space の中で解決されます。publisher は declaration を offer し、link materialization は runtime に渡す出力データを生成します。

Public manifest v1 が定義するのは `listen.<binding>.from` の reference grammar です。2 segment の `component.publication` は同じ manifest 内の publication、 3 segment 以上の path は Space-visible platform service として解決します。この architecture note は、reference implementation が内部で使う snapshot / link / exposure record も説明します。

## Platform service path 文法 {#publication-path-grammar}

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

Rules:

- min segments: 3
- max segments: 8
- max path length: 255
- path segment は上記 grammar の single segment
- empty segments are invalid
- first segment is the publisher root
- publisher roots are defined by the operator profile or product distribution that offers the publication path. Takosumi Cloud defines its account layer publisher root in its distribution specification; start from [Takosumi Cloud](../takosumi-cloud.md).

## Declaration と materialization {#declaration-vs-materialization}

### PlatformServiceDeclaration {#externalpublicationdeclaration}

declaration は何が使えるかを宣言する。

```yaml
PlatformServiceDeclaration:
  snapshotId: pubsnap_...
  publicationPath: publisher.database.primary
  spaceId: space_acme_prod
  owner:
    kind: operator
    id: reference-operator
  contractRef: service-binding
  contractVersion: v1
  descriptorDigest: sha256:...
  sensitivity: internal
  accessModes:
    - read
    - read-write
  safeDefaultAccess: null
  freshness:
    state: fresh | stale | revoked | unknown
    observedAt: ...
```

`sensitivity` class は [Access Modes](../access-modes.md) と type catalog metadata の `public-config` / `internal` / `restricted` / `secret-bearing` を使います。この architecture note では enum を再定義しません。

### PublicationMaterialization {#publicationmaterialization}

出力データは link materialization によって生成される。

```yaml
PublicationMaterialization:
  linkId: link_api_DATABASE_URL
  publicationSnapshotId: pubsnap_...
  publicationPath: publisher.database.primary
  secretRefs: [secret://operator/databases/acme-prod/api]
  endpointRefs: []
  authorizationRefs: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution は declaration を保存する。OperationJournal と observation が出力データを追跡する。

## Explicit paths {#explicit-paths}

Public manifest grammar には hidden path 展開はありません。manifest author は `publisher.observability.default` のように leaf まで明示します。`default` は通常の segment で、bare path を暗黙に別 path へ展開する規則は v1 には置きません。

## Space-scope resolution {#space-scoped-resolution}

platform service resolution は常に Space の中で行われる。別 Space の同じ path は別の subject である。current v1 の依存は Space に許可された external publication に限られる。

```text
1. Space-visible platform service declarations
2. absent optional binding, or required-binding failure
```

deployment-local object scope、generated scope、group / environment scope、 cross-space import は internal/future vocabulary です。導入する場合も public platform service path の exact-match model を変えず、別 RFC で manifest から見える surface を定義します。

## Cross-Space sharing {#cross-space-sharing}

current v1 の platform service resolution は Space-local です。Space を跨ぐ publication 使用は reserved sharing model として扱います。

```yaml
fromSpaceId: space_platform
toSpaceId: space_acme_prod
publicationPath: publisher.identity.primary
publicationSnapshotId: pubsnap_...
allowedAccess:
  - read
  - invoke-only
```

share と plan 出力は Space を跨ぐ使用を risk として明示しなければならない。

## Freshness {#freshness}

```text
fresh:
  usable

stale:
  policy decides allow-with-warning, require-refresh, or deny

revoked:
  deny

unknown:
  policy decides require-refresh or deny
```

## Adjacent Boundaries {#adjacent-boundaries}

Platform service は manifest 外の material を `listen` に参加させる仕組みです。source handoff、asset、connector、public ingress activation は別の boundary です。

| Boundary                          | Reference                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| source input / prepared source    | [Installer API](../installer-api.md) and [Build Service Handoff](../build-spec.md) |
| optional asset blob extension     | [Operator asset Extension Policy](../data-asset-policy.md)                         |
| runtime-agent connector inventory | [Connector Guide](../connector-contract.md)                                        |
| public ingress activation         | [イングレスルーティング](./ingress-routing.md)                                     |
