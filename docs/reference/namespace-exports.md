# Namespace Exports

> このページでわかること: namespace export の仕組みと使い方。

Namespace export は operator / account plane / billing / dashboard / deploy API
など、kernel Shape manifest の外にある usable surface を Space-scoped に公開する
contract です。kernel は namespace export を discover / grant / fetch せず、
compiled Shape manifest だけを受け取ります。

## Path Grammar

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- 最大 8 segments、最大 255 chars。
- empty segment は invalid。
- `@v1` のような version suffix は path に含めない。
- `default` は leaf segment としてだけ使える。
- `operator` prefix は operator が Space-visible export として publish する
  surface に使う。

Current v1 examples:

```text
operator.identity.oidc
operator.billing.default
operator.dashboard.web
operator.platform.deploy
```

### v1 maturity

本 grammar は「将来の cross-space / external participant / namespace import
を見据えた future-proof spec」 として定義されている。 v1 実 usage は 4
operator-owned path のみ: `operator.identity.oidc` / `operator.billing.default`
/ `operator.dashboard.web` / `operator.platform.deploy`。 8 segments / 255 chars
/ leaf segment 限定 等の strict grammar は v1 では over-spec 寄りだが、 future
RFC で path namespace 拡張時の breaking change を避けるため early
に固定している。

v1 contributor は: (1) operator-owned path のみ追加する、 (2) 新 path 追加時は
spec を update する、 (3) Space-owned / external-participant / cross-space share
の path は future RFC まで使わない。

## Owner Model

Current v1 の namespace export owner は **`operator` のみ** です。app は
`operator.*` を shadow できません。 Space-owned / external-participant /
app-installation / cross-space share owner kind は reserved vocabulary であり、
future RFC + acceptance gate で enable されるまで使えません (§v1 maturity
参照)。

| owner kind | 例                       | 責務                                                 |
| ---------- | ------------------------ | ---------------------------------------------------- |
| `operator` | `operator.identity.oidc` | Takosumi Accounts / billing / dashboard / deploy API |

## Declaration And Material

`ExportDeclaration` は「何を使ってよいか」を表す immutable snapshot
です。`ExportMaterial` は link / grant materialization の結果です。

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  namespacePath: operator.identity.oidc
  spaceId: space:acme-prod
  owner:
    kind: operator
    id: takosumi-accounts
  contractRef: takosumi.accounts.oidc-issuer@v1
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

Declarations may include endpoint refs, SDK config refs, runtime handles, or
grant-producing metadata. Raw secret values are never stored in declarations or
audit events.

## Versioning

Path は human-stable name であり version carrier ではありません。version は
`contractRef` / `contractVersion` / immutable `snapshotId` / `descriptorDigest`
で扱います。

- Non-breaking change: same `namespacePath`, new `snapshotId`, compatible
  `contractVersion`。
- Breaking change: new `contractVersion` and explicit migration policy or new
  leaf path。
- Snapshot は immutable。既存 grant / link は materialize 時点の
  `exportSnapshotId` を audit に残します。

## Discovery

Discovery は Space-scoped です。同じ path でも別 Space では別 subject です。

Resolution order:

1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace
5. space namespace
6. operator namespace granted to the Space

Consumer は Accounts API / operator dashboard / install context から namespace
export declaration を discover します。OIDC の場合、`operator.identity.oidc`
export から issuer discovery URL を得て、その後は OIDC discovery contract
を使います。 特定 hostname は contract ではありません。

## Grants

Namespace export は default-deny です。consumer は Link / AppGrant / account API
operation のいずれかで explicit grant を得ます。

- `read` は metadata / public config の読み取り。
- `call` は endpoint invocation。
- `read-write` は producer が許可した mutable operation。
- `admin` は implicit になりません。必ず explicit approval を要求します。

## Audit

Namespace export lifecycle は append-only audit に残します。

```text
namespace_export.published
namespace_export.snapshot_created
namespace_export.revoked
namespace_export.link_materialized
namespace_export.grant_issued
namespace_export.grant_revoked
```

Audit payload には
actor、Space、`namespacePath`、`exportSnapshotId`、`descriptorDigest`、grant
id、installation id を 記録します。raw secret、token、OIDC client secret は
audit payload に入れません。
