# Space モデル {#space-model}

> このページでわかること: space モデルの設計と分離ルール。

`Space` は Takosumi v1 のトップレベル isolation 境界である。

AppSpec は Space を宣言しない。deploy / preview / apply リクエストは、actor
auth、API path、operator context、CLI profile が選んだ Space で実行される。 各
Space は独自の namespace scope、policy、kind alias / descriptor visibility、
secret、operator DataAsset extension policy、approval、journal、observation、
GroupHead を持つため、同じ AppSpec が Space ごとに異なる resolve
結果になりうる。

## Space ルートルール {#space-root-rule}

```text
Space は意味・authority・ownership の境界である。
```

すべての `Deployment`、`ResolutionSnapshot`、`DesiredSnapshot`、
`OperationJournal`、`ObservationSet`、`RevokeDebt`、`ActivationSnapshot`、
approval、`GroupHead` は厳密に 1 つの Space に属する。

```yaml
Space:
  id: space:acme-prod
  displayName: Acme Production
  kindAliases:
    worker: https://takosumi.com/kinds/v1/worker
    postgres: https://takosumi.com/kinds/v1/postgres
  kindVisibilityPolicy: prod/strict
  policyPack: prod/strict
  namespaceRegistryDigest: sha256:...
  secretPartition: space:acme-prod
  dataAssetExtensionPartition: space:acme-prod
```

## Space と namespace {#space-vs-namespace}

namespace path は Space scope の namespace テーブル内の名前である。

```text
operator.identity.oidc
operator.database.primary
```

2 つの Space にある同じ namespace path は、両方の Space が同じ export snapshot
を明示的に import / share したときに同じ ExportDeclaration として扱う。

```text
space:acme-prod / operator.database.primary
space:acme-dev  / operator.database.primary
```

これらは別個の resolution subject である。

## アドレス qualification {#address-qualification}

canonical record は identity の一部として `spaceId` を持つ。テキスト表現は tuple
または qualified address のいずれかで描画できる。

```text
(space:acme-prod, object:api)
space:acme-prod/object:api
space:acme-prod/link:api.DATABASE_URL
```

storage では tuple 形式が望ましい。qualified 文字列は log、plan 出力、audit
event で有用である。

## Namespace スコープスタック {#namespace-scope-stack}

public AppSpec v1 の `namespace:<path>` resolution は Space の中で行われ、Space
に可視化された operator-owned export declaration を exact match で見る。以下の
scope は reference implementation が内部 record を整理するために使える
vocabulary であり、AppSpec author が `namespace:<path>` で選ぶ public source
ではありません。

```text
public:
  operator namespace granted to this Space

internal / future:
  deployment-local object namespace
  deployment-local generated namespace
  group namespace
  environment namespace
  space namespace
  explicitly shared namespace imports from another Space
```

current public v1 では operator namespace の exact match が正本です。内部
namespace を導入する場合も public `operator.*` export を shadow しないよう
policy で fail-closed にします。

## 予約 prefix {#reserved-prefixes}

public v1 の予約 prefix は `operator` です。名前はグローバルに見えても、
可視性は Space scope です。reference implementation が内部整理に `system` などの
prefix を使う場合も、AppSpec author が選ぶ public namespace source
ではありません。

```text
operator
```

これらの prefix を publish できるのは operator
だけである。`operator.identity.oidc` のような予約 export も、resolution
で使う前にその Space に grant されるか可視にされる必要がある。product-specific
prefix は internal / future scope として扱い、current public v1 の
`namespace:<path>` source にはしません。

predefined な operator-owned namespace は Space に明示的に grant される。

```yaml
ExternalNamespaceRegistration:
  spaceId: space:acme-prod
  path: operator.database.primary
  owner:
    kind: operator
    id: reference-operator
  exportSnapshotId: export-snapshot:...
  freshness:
    state: fresh
```

public v1 の依存は、同じ AppSpec 内の `component.publication` と、対象 Space に
可視化された operator-owned `ExportDeclaration.namespacePath` を exact match
で解決する `namespace:<path>` です。

## Space 跨ぎ link {#cross-space-links}

Space 跨ぎ link は reserved sharing model です。current v1 の AppSpec authoring
surface からは作れません。

```yaml
fromSpaceId: space:platform
toSpaceId: space:acme-prod
exportPath: operator.identity.oidc
exportSnapshotId: export-snapshot:...
allowedAccess:
  - read
  - invoke-only
expiresAt: optional
```

`ResolutionSnapshot` と plan 出力は Space 跨ぎ利用を risk として示さなければ
ならない。

```text
draft → active → refresh-required → stale → revoked
              ↘ revoked
```

| state              | meaning                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `draft`            | operator created the share but has not activated it; consumers cannot resolve it                                   |
| `active`           | the share is usable; consumer Spaces resolve and link normally                                                     |
| `refresh-required` | the export snapshot or credential is approaching its TTL; resolution still succeeds, plan output shows the warning |
| `stale`            | the TTL elapsed before refresh; resolution surfaces the `stale-export` Risk and then fails closed                  |
| `revoked`          | operator removed the share; new resolutions are denied and existing material enters cleanup                        |

Refresh / TTL 規則:

- 各 share は `expiresAt` と operator 管理の refresh policy を持つ。TTL に
  近づくと `active → refresh-required` に遷移する。
- refresh 成功は share を `active` に戻す。refresh 失敗は `stale` に遷移する。
- `stale` と `revoked` はいずれも [Drift Detection](../drift-detection.md)
  に従って依存する生成 material の cleanup を queue する。cleanup 失敗は
  `reason: cross-space-share-expired` の RevokeDebt を生成する。
- `stale-export` と `revoke-debt-created` は
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
  の closed Risk enum の一部である。

## Space 所有データ境界 {#space-owned-data-boundaries}

Space は以下の partition を所有または選択する。

```text
namespace registry visibility
secret-store partition
operator DataAsset visibility / retention policy
operation journals
observation sets
audit event partition
approvals and policy decisions
group heads and activation history
```

Space isolation はすべてのデータが物理的に別 database に保管されることを意味
しない。すべての読み込み・書き込み・resolution・operation が `spaceId` と policy
で scope されることを意味する。

## Space 内の Group {#group-inside-space}

`Group` は Space 内の deployment stream である。`GroupHead` の identity は:

```text
spaceId + groupId
```

例:

```text
space:acme-prod/group:web
space:acme-prod/group:api
space:acme-dev/group:web
```

GroupHead 更新は所有 Space 内で直列化される。Group は別の Space で current に
なることはできない。

## Space 不変条件 {#space-invariants}

```text
Space containment invariant:

Namespace isolation invariant:
  Namespace paths are Space-scoped. Same path in different Spaces is not the same export by default.

Secret isolation invariant:
  Secret references created for a Space must not be projected into another Space unless an explicit share policy allows it.

DataAsset extension isolation invariant:
  Operator DataAsset visibility is Space-scoped unless operator policy allows sharing.

Journal isolation invariant:
  OperationJournal entries belong to one Space and must not be used as recovery authority in another Space.

Activation isolation invariant:
  ActivationSnapshot and GroupHead updates are Space-local.
```

## 最小例 {#minimal-example}

AppSpec は Space を言及しない。 Space は installer request の `spaceId`
で決まる。

```yaml
apiVersion: v1

metadata:
  id: com.example.api
  name: API

components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  api:
    kind: worker
    listen:
      database:
        from: db.connection
        as: env
        prefix: DATABASE
    spec:
      entrypoint: dist/worker.mjs
```

`space:acme-prod` で apply すると、resource graph、選ばれた provider、output
ref、policy、secret、prepared source、GroupHead はすべて production Space
に対して resolve される。

```text
space:acme-prod/db.connection
```

`space:acme-dev` で apply すると、同じ AppSpec が development Space に対して
resolve される。

```text
space:acme-dev/db.connection
```
