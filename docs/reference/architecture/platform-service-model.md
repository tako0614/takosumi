# Platform Service モデル {#platform-service-model}

Operator platform service compatibility model:
[Platform Services](../platform-services.md).

Platform service は platform service path で参照できる usable surface です。
platform service path は Space の中で解決されます。operator distribution または
product distribution は service entry を offer し、link materialization は
runtime に渡す binding data を生成します。

Public manifest v1 が定義する外部接続は `connect.output`、`listen.path`、
`listen.kind` です。2 segment の `component.output` は同じ manifest 内の
component output、3 segment 以上の path は Space-visible platform service の
exact name、`listen.kind` は Space-visible publication の discovery selector
として解決します。この architecture note は、reference implementation が内部で使う
snapshot / link / exposure record も説明します。

## Platform service path 文法 {#platform-service-path-grammar}

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
- first segment is the service root
- service roots are defined by the operator distribution or product
  distribution that offers the platform service path. Takosumi Cloud defines its
  account layer service roots in its distribution specification; start from
  [Takosumi Cloud](../takosumi-cloud.md).

## Declaration と materialization {#declaration-vs-materialization}

### PlatformServiceDeclaration {#platform-service-declaration}

declaration は何が使えるかを宣言する。

```yaml
PlatformServiceDeclaration:
  snapshotId: svcsnap_...
  platformServicePath: database.primary.connection
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

`sensitivity` class は [Access Modes](../access-modes.md) と official catalog
metadata の `public-config` / `internal` / `restricted` / `secret-bearing`
を使います。この architecture note では enum を再定義しません。

### PlatformServiceMaterialization {#platform-service-materialization}

出力データは link materialization によって生成される。

```yaml
PlatformServiceMaterialization:
  linkId: link_api_DATABASE_URL
  platformServiceSnapshotId: svcsnap_...
  platformServicePath: database.primary.connection
  secretRefs: [secret://operator/databases/acme-prod/api]
  endpointRefs: []
  authorizationRefs: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution は declaration を保存する。OperationJournal と observation
が出力データを追跡する。

## Explicit paths {#explicit-paths}

Public manifest grammar には hidden path 展開はありません。manifest author は
`observability.primary.logs` のように leaf まで明示します。`default`
は通常の segment で、bare path を暗黙に別 path へ展開する規則は v1
には置きません。

## Space-scope resolution {#space-scoped-resolution}

platform service resolution は常に Space の中で行われる。別 Space の同じ path
は別の subject である。current v1 の manifest 外依存は Space に許可された
platform service に限られる。

```text
1. Space-visible platform service declarations
2. absent optional binding, or required-binding failure
```

deployment-local object scope、generated scope、group / environment scope、
cross-space service sharing は future RFC vocabulary です。導入する場合も public
platform service path の exact-match model を変えず、別 RFC で manifest から
見える surface を定義します。

## Active path uniqueness {#active-path-uniqueness}

同じ Space の同じ platform service path は、active provider を 1 つだけ持てます。これは `listen.path` の exact-match
resolution を曖昧にしないための invariant です。

この制約は path を持つ publication だけに適用します。path を持たない publication
は `kind` と optional labels で discover され、同じ material kind が同じ Space
に複数存在できます。MCP server のように「見えるものを全部受け取る」対象は
path を割り当てず、consumer が `listen.kind: mcp-server@v1` と `many: true`
で collection として受け取ります。`type` という別 selector は置かず、component
selector も publication selector も `kind` に揃えます。

root `publish` declaration を inventory に投影する operator は、`(spaceId, path)` を active-entry key として扱います。owner
Installation が同じなら redeploy は replacement です。owner が違うなら conflict です。conflict は新しい AppSpec が既存
entry を奪う形では解決しません。既存 owner の publish removal、Installation disable/delete、または operator/admin の明示的な
transfer / disable operation で片方を inactive にしてから activate します。

rollback も同じ rule に従います。rollback target が持つ path が空いていれば再 activate できます。別 owner が active
なら rollback projection は conflict で止まります。Deployment history は残りますが、`listen.path` から見える active
entry は常に 1 つです。

## Cross-Space sharing {#cross-space-sharing}

current v1 の platform service resolution は Space-local です。Space を跨ぐ
service sharing は future RFC scope であり、current manifest v1 には
cross-Space service input はありません。

将来 RFC が導入する場合は、source Space、destination Space、service path、
service snapshot、allowed access、TTL、revocation、audit、cleanup をまとめて
定義し、plan 出力は Space を跨ぐ使用を risk として明示しなければならない。

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

Platform service は manifest 外の material を `listen`
に参加させる仕組みです。source handoff、asset、connector、public ingress
activation は別の boundary です。

| Boundary                          | Reference                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| source input / prepared source    | [Installer API](../installer-api.md) and [Build Service Handoff](../build-spec.md) |
| optional asset blob extension     | [Operator asset Extension Policy](../data-asset-policy.md)                         |
| runtime-agent connector inventory | [Connector Guide](../connector-contract.md)                                        |
| public ingress activation         | [イングレスルーティング](./ingress-routing.md)                                     |
