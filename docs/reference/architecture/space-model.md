# Space Model

> このページでわかること: space モデルの設計と分離ルール。

`Space` は Takosumi v1 のトップレベル isolation 境界である。

manifest は Space を宣言しない。deploy / preview / apply リクエストは、actor
auth、API path、operator context、CLI profile が選んだ Space で実行される。 各
Space は独自の namespace scope、policy、許可された catalog release、secret、
artifact、approval、journal、observation、GroupHead を持つため、同じ manifest が
Space ごとに異なる resolve 結果になりうる。

## Space root rule

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
  defaultCatalogReleaseId: catalog-release-2026-05-04.1
  allowedCatalogReleaseIds:
    - catalog-release-2026-05-04.1
  policyPack: prod/strict
  namespaceRegistryDigest: sha256:...
  secretPartition: space:acme-prod
  artifactPartition: space:acme-prod
```

## Space vs namespace

namespace path は Space scope の namespace テーブル内の名前である。

```text
takos.oauth.token
billing.default
takos.database.primary
```

2 つの Space にある同じ namespace path は、両方の Space が同じ export snapshot
を明示的に import / share しない限り、同じ ExportDeclaration ではない。

```text
space:acme-prod / takos.database.primary
space:acme-dev  / takos.database.primary
```

これらは別個の resolution subject である。

## Address qualification

canonical record は identity の一部として `spaceId` を持つ。テキスト表現は tuple
または qualified address のいずれかで描画できる。

```text
(space:acme-prod, object:api)
space:acme-prod/object:api
space:acme-prod/link:api.DATABASE_URL
```

storage では tuple 形式が望ましい。qualified 文字列は log、plan 出力、audit
event で有用である。

## Namespace scope stack

resolution は Space の中で行われる。resolver は次の順で scope をチェックする。

```text
1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace, if the Space defines environments
5. space namespace
6. operator namespace granted to this Space
8. reserved: explicitly shared namespace imports from another Space
```

namespace path が複数 scope に存在する場合、shadowing policy が許可するときに
限り最初の一致 scope が勝つ。本番 policy は意味のある shadowing を拒否するか
approval を要求すべきである。

## Reserved prefixes

予約 prefix はグローバル名だが、可視性は依然として Space scope である。

```text
takos
operator
system
```

これらの prefix を publish できるのは operator だけである。`takos.oauth.token`
のような予約 export も、resolution で使う前にその Space に grant されるか可視に
される必要がある。

predefined な operator-owned namespace は Space に明示的に grant される。

```yaml
ExternalNamespaceRegistration:
  spaceId: space:acme-prod
  path: takos.database.primary
  owner:
    kind: external-participant
    id: db-platform
  exportSnapshotId: export-snapshot:...
  freshness:
    state: fresh
```

v1 の依存はこれを必須にしてはならない。

## Cross-space links

Space 跨ぎ link はデフォルトで拒否され、current v1 の依存ではない。

```yaml
fromSpaceId: space:platform
toSpaceId: space:acme-prod
exportPath: takos.oauth.token
exportSnapshotId: export-snapshot:...
allowedAccess:
  - read
  - call
expiresAt: optional
```

`ResolutionSnapshot` と plan 出力は Space 跨ぎ利用を risk として示さなければ
ならない。

```text
draft → active → refresh-required → stale → revoked
              ↘ revoked
```

| state              | meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `draft`            | operator created the share but has not activated it; consumers cannot resolve it                                    |
| `active`           | the share is usable; consumer Spaces resolve and link normally                                                      |
| `refresh-required` | the export snapshot or signing key is approaching its TTL; resolution still succeeds, plan output shows the warning |
| `stale`            | the TTL elapsed before refresh; resolution surfaces the `stale-export` Risk and then fails closed                   |
| `revoked`          | operator removed the share; new resolutions are denied and existing material enters cleanup                         |

Refresh / TTL 規則:

- 各 share は `expiresAt` と operator 管理の refresh policy を持つ。TTL に
  近づくと `active → refresh-required` に遷移する。
- refresh 成功は share を `active` に戻す。refresh 失敗は `stale` に遷移する。
- `stale` と `revoked` はいずれも
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
  に従って依存する生成 material の cleanup を queue する。cleanup 失敗は
  `reason: cross-space-share-expired` の RevokeDebt を生成する。
- `stale-export` と `revoke-debt-created` は
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
  の closed Risk enum の一部である。

## Space-owned data boundaries

Space は以下の partition を所有または選択する。

```text
namespace registry visibility
secret-store partition
artifact visibility / retention policy
operation journals
observation sets
audit event partition
approvals and policy decisions
group heads and activation history
```

Space isolation はすべてのデータが物理的に別 database に保管されることを意味
しない。すべての読み込み・書き込み・resolution・operation が `spaceId` と policy
で scope されることを意味する。

## Group inside Space

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

## Space invariants

```text
Space containment invariant:

Namespace isolation invariant:
  Namespace paths are Space-scoped. Same path in different Spaces is not the same export by default.

Secret isolation invariant:
  Secret references created for a Space must not be projected into another Space unless an explicit share policy allows it.

Artifact isolation invariant:
  DataAsset visibility is Space-scoped unless operator artifact policy allows sharing.

Journal isolation invariant:
  OperationJournal entries belong to one Space and must not be used as recovery authority in another Space.

Activation isolation invariant:
  ActivationSnapshot and GroupHead updates are Space-local.
```

## Minimal example

manifest は Space を言及しない。

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: api
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    spec: { version: "16", size: small }

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:...
      port: 8080
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
```

`space:acme-prod` で apply すると、resource graph、選ばれた provider、output
ref、policy、secret、artifact、GroupHead はすべて production Space に対して
resolve される。

```text
space:acme-prod/takos.database.primary
```

`space:acme-dev` で apply すると、同じ manifest が development Space に対して
resolve される。

```text
space:acme-dev/takos.database.primary
```
