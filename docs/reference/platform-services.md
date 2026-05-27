# プラットフォームサービス {#platform-services}

プラットフォームサービスは、operator distribution、account plane、product
distribution、他の Installation などが Space に公開する service material
です。manifest 内の component は `listen.path` で exact match
するか、`listen.kind` と `labels` で discovery して受け取ります。

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        kind: identity.oidc@v1
        inject: secret-env
        prefix: IDENTITY
        required: true
      tools:
        kind: mcp-server@v1
        labels:
          capability: docs
        many: true
        inject: config-mount
```

`connect` は同じ manifest 内の component output 用です。`listen` は manifest
外の Space-visible publication 用です。

## 使い分け

| やりたいこと                              | 書き方                       | 競合ルール                                   |
| ----------------------------------------- | ---------------------------- | -------------------------------------------- |
| 確定した 1 つの service を名指しする      | `listen.path`                | 同じ Space の同じ path は active 1 件だけ    |
| MCP server など同じ kind のものを全部使う | `listen.kind` + `many: true` | path を持たない publication は複数存在できる |
| 1 件だけ discovery したい                 | `listen.kind` + labels       | 0 件または 2 件以上なら apply error          |
| component output を同じ manifest で使う   | `connect.output`             | Space-visible path には参加しない            |

AppSpec の selector field は `kind` だけです。component を選ぶときも、公開 /
参照する material を選ぶときも `kind` を使います。`type` は JSON Schema、JSON-LD
`@type`、TypeScript 型名の文脈に限ります。

## Path Grammar

`listen.<binding>.path` は exact match 用の dotted path です。

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

ルール:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- empty segment は invalid

`identity.primary.oidc` や `acme.database.reporting` のような path は exact
match で解決します。path は stable な名前が必要な publication
だけに付けます。`db.connection` のような 2 segment component output との区別は
field で決まります。component output は `connect.output`、manifest 外の exact
service は `listen.path` に書きます。

## Publication Kind And Discovery

`kind` は component だけでなく publication / material にも使います。component
`kind` は「何を作るか」、publication `kind` は「何を提供するか」です。

```yaml
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server@v1
        many: true
        inject: config-mount
```

この例は Space で見える `mcp-server@v1` publication 全部を 1 つの collection
material として受け取ります。`labels` を指定すると selector は `kind` と label
の両方に一致する publication だけを返します。`many` を省略した場合は一致が
ちょうど 1 件でなければ apply error です。

`mcp-server@v1` は公式カタログの discoverable material kind です。Takosumi
core は MCP を special-case せず、通常の material kind として扱います。Takos
product や operator distribution が MCP server publication を Space に offer
すれば、AppSpec は同じ `listen.kind` mechanism で「全部」または label で絞った集合を受け取れます。

集合 discovery は path の代替です。MCP server、tool endpoint、補助 service
のように「Space で見えるものを全部受け取りたい」対象は、path を付けずに
publication を出し、consumer が `kind` と optional `labels` で選びます。
`many: true` の collection は各 publication entry を失わずに渡し、operator
は順序を deterministic にし、Deployment の記録に選択結果を残します。

## Path Ownership

path inventory、lifecycle、ownership は、その path を提供する distribution や
organization が定義します。Takosumi core は path を special-case せず、grammar
と exact-match resolution を扱います。

| Provider example                 | Example path              |
| -------------------------------- | ------------------------- |
| Account plane                    | `identity.primary.oidc`   |
| Billing provider                 | `billing.primary.account` |
| Organization or private operator | `acme.database.reporting` |

Takosumi Cloud や別の operator distribution は、自分の distribution spec で
concrete path を公開できます。それらは Takosumi core concept
ではなく、Space-visible service material の provider-owned names です。

## Resolution

Resolution は Space-scoped です。

1. operator は target Space に visible な platform service entry / publication
   を集める。
2. path を持つ active visible entry は `(Space, path)` で unique にする。
3. `listen.path` は exact match で解決する。
4. `listen.kind` は visible publication を kind / labels で選択する。
5. 選択した service state と materialization evidence を Deployment
   の記録に残す。
6. 対象が absent で `required: true` の場合、apply は resource creation
   の前に失敗する。
7. 対象が absent で `required` が omitted / false の場合、その binding
   は作られない。

optional binding が absent のときに kind-specific `spec` がその binding
を必須として扱う場合、apply は失敗します。degraded behavior
を許す場合は、採用した kind definition と operator record
にその扱いを明示します。

## Path Uniqueness And Conflict

同じ Space の同じ platform service path に対して、active な provider は 1
つだけです。これは path を持つ publication だけの制約です。path を持たない
publication は `kind` / `labels` discovery の候補になり、同じ `kind`
が複数存在できます。 `listen.path` は exact match で解決されるため、2 つの
active entry を優先順位で選ぶ規則は置きません。

active entry の owner は、その path を現在 offer している distribution /
Installation / operator record です。root `publish` から作られた entry の owner
は、少なくとも `spaceId`、`installationId`、`publish` name、source output
を持ちます。Deployment が変わっても owner Installation が同じなら、同じ service
の更新として扱えます。

path の競合は exact path だけで判定します。`kind` が同じ publication
が複数あることは競合ではありません。`type` という別 selector
は置かず、component と publication の分類はどちらも `kind` で表します。

| 状況                                                 | ルール                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 つの AppSpec 内で root `publish.path` が重複する   | AppSpec validation で reject。                                                                        |
| 同じ Installation が同じ path を再 deploy する       | current projection を新しい Deployment の output に置き換える。古い snapshot は inactive。            |
| 同じ Installation が root `publish` を消す           | その Installation が owner の active projection を off にする。Deployment history は残す。            |
| 同じ Installation が path を変更する                 | 旧 path を off にし、新 path を activate する。新 path が既に使われていれば apply/projection は失敗。 |
| 別 Installation が同じ path を publish する          | default は conflict。既存 owner を自動で off にせず reject / blocked にする。                         |
| path のない publication が複数存在する               | conflict ではない。`listen.kind` + `labels` selector の候補になる。                                   |
| `listen.kind` が複数一致し `many` が false / omitted | apply error。単一にしたい場合は labels / path で絞る。                                                |
| `listen.kind` が複数一致し `many: true`              | 一致した publication 全部を collection material として binding する。                                 |
| operator-reserved path に workload が publish する   | policy violation として reject。                                                                      |
| rollback で以前の path を再 activate する            | その path が空いていれば activate。別 owner が active なら rollback/projection は conflict。          |
| Installation delete / disable                        | その Installation が owner の active projection を off にする。                                       |

競合を解消する方法は、既存 owner が root `publish` を消す、Installation を
disable/delete する、または operator/admin が明示的な transfer / disable
操作を行うことです。AppSpec だけで別 owner の active entry
を奪うことはできません。

operator が root `publish` declaration を Space-visible inventory
に投影する場合、projection は `(Space, path)` の compare-and-set
として扱います。同時に 2 つの apply が同じ path を activate
しようとした場合、片方だけが成功し、もう片方は conflict として失敗または blocked
状態になります。どちらの場合も、`listen.path` から見える active entry は常に 1
つです。

## Service Material

platform service entry は material shape、sensitivity、access metadata
を持ちます。material vocabulary は Takosumi 公式カタログまたは operator-adopted
catalog が提供し、実際の credential、endpoint、authorization は operator
implementation が materialize します。

実装側の record 例:

```yaml
PlatformServiceDeclaration:
  snapshotId: svcsnap_...
  path: identity.primary.oidc
  spaceId: space_acme_prod
  kind: identity.oidc@v1
  sensitivity: restricted
```

```yaml
PlatformServiceMaterialization:
  linkId: link_inst_abc_identity
  declarationSnapshotId: svcsnap_...
  path: identity.primary.oidc
  endpointRefs: []
  secretRefs: []
  authorizationRefs: []
```

public Deployment output は [Installer API](./installer-api.md#deployment)
が定義する non-secret field だけを返します。raw credential は operator の secret
delivery に残します。

## 関連ページ

- [Takosumi core 仕様](./core-spec.md)
- [manifest](./manifest.md)
- [アクセスモード](./access-modes.md)
- [Takosumi 公式カタログ仕様](./catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
