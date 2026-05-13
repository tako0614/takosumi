# Namespace Export Model

> このページでわかること: namespace export のモデル定義と使い方。

Root-level canonical spec:
[Namespace Exports](https://github.com/tako0614/takosumi/blob/master/docs/reference/namespace-exports.md).

Export は namespace アドレス可能な usable surface である。namespace path は
Space の中で解決される。producer は export declaration を publish し、link
materialization は export material を生成する。

## Namespace path grammar

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- max segments: 8
- max path length: 255
- component names are single segments
- empty segments are invalid
- `default` is allowed only as an export leaf
- reserved namespace prefixes are operator-controlled and Space-visible only
  when granted by operator policy

Reserved prefixes:

```text
takos
operator
system
```

## ExportDeclaration vs ExportMaterial

### ExportDeclaration

declaration は何が使えるかを宣言する。

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  path: takos.database.primary
  spaceId: space:acme-prod
  scope: environment:prod
  owner:
    kind: external-participant
    id: db-platform
  descriptorDigest: sha256:...
  sensitivity: secret | restricted | public
  defaultProjection: null
  projectionVariants: []
  effectFamilies:
    - grant
    - secret
  effectDetails: {}
  accessModes:
    - read
    - read-write
  safeDefaultAccess: null
  freshness:
    state: fresh | stale | revoked | unknown
    observedAt: ...
```

### ExportMaterial

material は link materialization によって生成される。

```yaml
ExportMaterial:
  linkId: link:api.DATABASE_URL
  exportSnapshotId: export-snapshot:...
  secretRefs: []
  endpointRefs: []
  grantHandles: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution は declaration を保存する。OperationJournal と observation が
material を追跡する。

## Default export

bare な namespace path は default export が存在するときにのみ `.default` に
展開される。

```text
billing -> billing.default
```

default export は admin access を意味してはいけない。grant を生む default は
明示的な access なしに使うには `safeDefaultAccess` が必要である。`read-write` と
`admin` は決して暗黙ではない。

## Space-scoped namespace resolution

namespace resolution は常に Space の中で行われる。別 Space の同じ path は別の
subject である。current v1 の依存は Space に許可された operator 所有の namespace
export に限られる。

```text
1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace, if defined by the Space
5. space namespace
6. operator namespace granted to the Space
8. reserved: explicitly shared namespace imports from another Space
```

shadowing は policy で gate される。production では意味のある shadowing は
拒否するか承認を要求すべきである。特にローカル namespace が Space / operator /
external namespace を shadow するケース。

## Space export sharing

Space を跨ぐ namespace 使用は default で拒否され、current v1 の機能ではない。

```yaml
fromSpaceId: space:platform
toSpaceId: space:acme-prod
exportPath: takos.oauth.token
exportSnapshotId: export-snapshot:...
allowedAccess:
  - read
  - call
```

share と plan 出力は Space を跨ぐ使用を risk として明示しなければならない。

## Freshness

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
