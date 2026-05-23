# Namespace exports {#namespace-exports}

> このページでわかること: AppSpec の component graph の外にある operator-owned
> material を、Space-scoped に公開する model。

Namespace export は、AppSpec component ではない外部 surface を `publish` /
`listen` と同じ namespace vocabulary で参照できるようにするための内部 model で
す。kernel は AppSpec installer lifecycle を扱い、export の発行元そのものは
operator distribution が所有します。

代表例は `operator.identity.oidc` です。kernel は OIDC client を発行しませんが、
operator が issuer material を namespace に publish すれば、worker component は
`listen` でそれを受け取れます。

## Path grammar {#path-grammar}

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- 最大 8 segments、最大 255 chars。
- empty segment は invalid。
- `@v1` のような version suffix は path に含めない。
- `default` は leaf segment としてだけ使う。
- `operator` prefix は operator が Space-visible export として publish する
  surface に使う。

Current examples:

```text
operator.identity.oidc
operator.platform.deploy
operator.observability.default
```

## Owner model {#owner-model}

current v1 で有効な owner は `operator` だけです。application component は
`operator.*` を shadow できません。Space-owned、external participant、
cross-space share は将来 RFC 用の reserved vocabulary であり、current docs の
contract ではありません。

## Declaration and material {#declaration-and-material}

`ExportDeclaration` は「何を使ってよいか」を表す immutable snapshot です。
`ExportMaterial` は link / grant materialization の結果です。

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  namespacePath: operator.identity.oidc
  spaceId: space:acme-prod
  owner:
    kind: operator
    id: reference-operator
  contractRef: operator.identity.oidc@v1
  contractVersion: v1
  descriptorDigest: sha256:...
  sensitivity: restricted
  accessModes: [read, call]
  safeDefaultAccess: read
  freshness:
    state: fresh
    observedAt: "2026-05-10T00:00:00Z"
```

```yaml
ExportMaterial:
  linkId: link:inst_abc.auth
  exportSnapshotId: export-snapshot:...
  namespacePath: operator.identity.oidc
  endpointRefs: [config://operator/oidc/discovery-url]
  secretRefs: []
  grantHandles: [grant:inst_abc:oidc-client]
```

Declaration は endpoint ref、SDK config ref、runtime handle、grant-producing
metadata を持てます。raw secret value は declaration、audit event、AppSpec に
保存しません。

## Versioning {#versioning}

Path は human-stable name であり version carrier ではありません。version は
`contractRef`、`contractVersion`、immutable `snapshotId`、`descriptorDigest`
で扱います。

- Non-breaking change: same `namespacePath`, new `snapshotId`, compatible
  `contractVersion`。
- Breaking change: new `contractVersion` and explicit migration policy or new
  leaf path。
- Snapshot は immutable。既存 grant / link は materialize 時点の
  `exportSnapshotId` を audit に残します。

## Discovery {#discovery}

Discovery は Space-scoped です。同じ path でも別 Space では別 subject です。

Resolution order:

1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace
5. space namespace
6. operator namespace granted to the Space

consumer は install context または operator API から namespace export
declaration を discover します。OIDC の場合、`operator.identity.oidc` export
から issuer discovery URL を得て、その後は OIDC discovery contract
を使います。特定 hostname は namespace export contract ではありません。

## Grants {#grants}

Namespace export は default-deny です。consumer は Link、permission grant、
operator API operation のいずれかで explicit grant を得ます。

| Access mode  | 意味                          |
| ------------ | ----------------------------- |
| `read`       | metadata / public config 読み |
| `call`       | endpoint invocation           |
| `read-write` | producer が許可した mutation  |
| `admin`      | explicit approval が必要      |

## Audit {#audit}

Namespace export lifecycle は append-only audit に残します。

```text
namespace_export.published
namespace_export.snapshot_created
namespace_export.revoked
namespace_export.link_materialized
namespace_export.grant_issued
namespace_export.grant_revoked
```

Audit payload には actor、Space、`namespacePath`、`exportSnapshotId`、
`descriptorDigest`、grant id、installation id を記録します。raw secret や token
は audit payload に入れません。
