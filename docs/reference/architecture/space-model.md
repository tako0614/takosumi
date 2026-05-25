# Space モデル {#space-model}

`Space` は operator account layer が提供する install scope です。Takosumi core は `spaceId` を request context と record field として扱い、その Space に見える kind の定義 / platform service / policy を使って apply を解決します。

manifest は Space を宣言しない。deploy / preview / apply リクエストは、actor auth、API path、operator context、CLI profile が選んだ Space で実行される。各 Space は独自の platform service visibility、policy、kind alias / kind の定義の visibility、secret partition、operator asset extension policy、 approval context を持つため、同じ manifest が Space ごとに異なる resolve 結果になりうる。

## 包含関係 {#containment}

```text
Operator profile / account registry
  └─ defines Account / Space membership and grants actor access

Takosumi core records
  └─ Installation (spaceId + manifest source)
       ├─ Deployment (= 1 apply result)
       └─ Deployment ...

Operator / reference implementation state
  ├─ Platform services visible to this Space
  ├─ Policy / secret / approval context
  └─ Optional routing / RoutingPointer / observation records
```

## Space ルートルール {#space-root-rule}

```text
Space は operator が与える visibility / policy / ownership context である。
```

すべての `Deployment`、`ResolvedPlan`、`TargetState`、 `OperationJournal`、`ObservationState`、`CleanupBacklog`、`TrafficSnapshot`、 approval、`RoutingPointer` は厳密に 1 つの Space に属する。

```yaml
Space:
  id: space_acme_prod
  displayName: Acme Production
  kindAliases:
    worker: https://takosumi.com/kinds/v1/worker
    postgres: https://takosumi.com/kinds/v1/postgres
  kindVisibilityPolicy: prod/strict
  policyPack: prod/strict
  externalPublicationDigest: sha256:...
  secretPartition: space_acme_prod
  dataAssetExtensionPartition: space_acme_prod
```

## Space と platform service {#space-vs-platform-service}

platform service path は Space scope の platform service table 内の名前である。

```text
publisher.identity.primary
publisher.database.primary
```

2 つの Space にある同じ platform service path は、それぞれの Space の platform service table で解決される別個の subject です。

```text
space_acme_prod / publisher.database.primary
space_acme_dev  / publisher.database.primary
```

これらは別個の resolution subject である。

## アドレス qualification {#address-qualification}

canonical record は identity の一部として `spaceId` を持つ。テキスト表現は tuple または qualified address のいずれかで描画できる。

```text
(space_acme_prod, obj_api)
space_acme_prod/obj_api
space_acme_prod/link_api_DATABASE_URL
```

storage では tuple 形式が望ましい。qualified 文字列は log、plan 出力、audit event で有用である。

## Platform service scope {#platform-service-scope}

public manifest v1 の platform service path resolution は Space の中で行われ、Space に可視化された platform service declaration を exact match で見る。以下の scope は reference implementation が内部 record を整理するために使える vocabulary であり、manifest author が `listen.from` で選ぶ public source ではありません。

```text
public:
  platform service visible inside this Space

internal / future:
  deployment-local object scope
  deployment-local generated scope
  group scope
  environment scope
  space scope
  explicit cross-Space publication shares
```

current public v1 では platform service の exact match が正本です。内部 scope を導入する場合も public platform service path を shadow しないよう policy で fail-closed にします。

## Publisher roots {#publisher-roots}

platform service path の first segment は publisher root です。名前はグローバルに見えても、可視性は Space scope です。Takosumi core の grammar は publisher root を plain segment として扱います。operator profile や product distribution が、自分の公開する publication path を distribution spec で定義します。

```text
publisher.area.name
publisher.database.primary
```

`publisher.database.primary` のような path も、resolution で使う前にその Space で visible になり、operator policy が access を許可する必要がある。Takosumi Cloud の concrete workload publication paths と account layer API / facade identifiers は Cloud distribution spec が定義するものであり、Takosumi core の特別な組み込み path ではありません。

operator が publish する platform service は Space に明示的に visible になります。

```yaml
ExternalPublicationVisibility:
  spaceId: space_acme_prod
  publicationPath: publisher.database.primary
  owner:
    kind: operator
    id: reference-operator
  publicationSnapshotId: pubsnap_...
  freshness:
    state: fresh
```

public v1 の依存は、同じ manifest 内の `component.publication` と、対象 Space に可視化された platform service declaration `publicationPath` を exact match で解決する platform service path です。

## Space 跨ぎ sharing {#cross-space-sharing}

current public v1 の platform service resolution は同一 Space 内で完結します。別 Space の publication を使う sharing model は将来 RFC の scope です。将来 RFC では owner、 TTL、revocation、audit、cleanup debt をまとめて定義します。

```yaml
fromSpaceId: space_platform
toSpaceId: space_acme_prod
publicationPath: publisher.identity.primary
publicationSnapshotId: pubsnap_...
allowedAccess:
  - read
  - invoke-only
expiresAt: optional
```

将来 RFC の lifecycle sketch:

```text
draft → active → refresh-required → stale → revoked
              ↘ revoked
```

| state              | meaning                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `draft`            | operator created the share but has not activated it; consumers cannot resolve it                                        |
| `active`           | the share is usable; consumer Spaces resolve and link normally                                                          |
| `refresh-required` | the publication snapshot or credential is approaching its TTL; resolution still succeeds, plan output shows the warning |
| `stale`            | the TTL elapsed before refresh; resolution surfaces the `stale-publication` Risk and then fails closed                  |
| `revoked`          | operator removed the share; new resolutions are denied and existing material enters cleanup                             |

Refresh / TTL 規則:

- 各 share は `expiresAt` と operator 管理の refresh policy を持つ。TTL に近づくと `active → refresh-required` に遷移する。
- refresh 成功は share を `active` に戻す。refresh 失敗は `stale` に遷移する。
- `stale` と `revoked` はいずれも dependency cleanup を queue する。
- future risk / debt reason は RFC 側で closed enum に追加する。

## Space 所有データ境界 {#space-owned-data-boundaries}

Space は以下の partition を持つまたは選択する。

```text
platform service registry visibility
secret-store partition
operator asset visibility / retention policy
operation journals
observation sets
audit event partition
approvals and policy decisions
group heads and activation history
```

Space isolation はすべてのデータが物理的に別 database に保管されることを意味しない。すべての読み込み・書き込み・resolution・operation が `spaceId` と policy で scope されることを意味する。

## Space 内の Group {#group-inside-space}

`Group` は Space 内の deployment stream である。`RoutingPointer` の identity は:

```text
spaceId + groupId
```

例:

```text
space_acme_prod/group_web
space_acme_prod/group_api
space_acme_dev/group_web
```

RoutingPointer 更新は所有 Space 内で直列化される。Group は別の Space で current になることはできない。

## Space 不変条件 {#space-invariants}

```text
Space containment invariant:

Platform service isolation invariant:
  Platform service paths are Space-scoped. Same path in different Spaces is not the same publication by default.

Secret isolation invariant:
  Secret references created for a Space must not be projected into another Space unless an explicit share policy allows it.

asset extension isolation invariant:
  Operator asset visibility is Space-scoped unless operator policy allows sharing.

Journal isolation invariant:
  OperationJournal entries belong to one Space and must not be used as recovery authority in another Space.

Activation isolation invariant:
  TrafficSnapshot and RoutingPointer updates are Space-local.
```

## 最小例 {#minimal-example}

manifest は Space を言及しない。 Space は installer request の `spaceId` で決まる。

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
        as: secret-env
        prefix: DATABASE
    spec:
      entrypoint: src/worker.ts
```

`space_acme_prod` で apply すると、publish/listen resolution、選ばれた provider、 output ref、policy、secret、prepared source、RoutingPointer はすべて production Space に対して resolve される。

```text
space_acme_prod/db.connection
```

`space_acme_dev` で apply すると、同じ manifest が development Space に対して resolve される。

```text
space_acme_dev/db.connection
```
