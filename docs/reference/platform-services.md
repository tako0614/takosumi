# プラットフォームサービス {#platform-services}

プラットフォームサービスは、operator distribution、account plane、product distribution などが Space に公開する service material です。manifest 内の component は `listen.path` で受け取ります。

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true
```

`connect` は同じ manifest 内の component output 用です。`listen` は manifest 外の Space-visible service 用です。

## Path Grammar

`listen.<binding>.path` は dotted path です。

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

ルール:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- empty segment は invalid

`identity.primary.oidc` や `acme.database.reporting` のような path は exact match で解決します。`db.connection` のような 2 segment component output との区別は field で決まります。component output は `connect.output`、manifest 外の service は `listen.path` に書きます。

## Path Ownership

path inventory、lifecycle、ownership は、その path を提供する distribution や organization が定義します。Takosumi core は path を special-case せず、grammar と exact-match resolution を扱います。

| Provider example                 | Example path              |
| -------------------------------- | ------------------------- |
| Account plane                    | `identity.primary.oidc`   |
| Billing provider                 | `billing.primary.account` |
| Organization or private operator | `acme.database.reporting` |

Takosumi Cloud や別の operator distribution は、自分の distribution spec で concrete path を公開できます。それらは Takosumi core concept ではなく、Space-visible service material の provider-owned names です。

## Resolution

Resolution は Space-scoped です。

1. operator は target Space に visible な platform service entry を集める。
2. active visible entry は `(Space, path)` で unique にする。
3. `listen.path` を exact match で解決する。
4. 選択した service state と materialization evidence を Deployment の記録に残す。
5. path が absent で `required: true` の場合、apply は resource creation の前に失敗する。
6. path が absent で `required` が omitted / false の場合、その binding は作られない。

optional binding が absent のときに kind-specific `spec` がその binding を必須として扱う場合、apply は失敗します。degraded behavior を許す場合は、採用した kind definition と operator record にその扱いを明示します。

## Path Uniqueness And Conflict

同じ Space の同じ platform service path に対して、active な provider は 1 つだけです。`listen.path` は exact match
で解決されるため、2 つの active entry を優先順位で選ぶ規則は置きません。

active entry の owner は、その path を現在 offer している distribution / Installation / operator record です。root
`publish` から作られた entry の owner は、少なくとも `spaceId`、`installationId`、`publish` name、source output
を持ちます。Deployment が変わっても owner Installation が同じなら、同じ service の更新として扱えます。

| 状況                                               | ルール                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 つの AppSpec 内で root `publish.path` が重複する | AppSpec validation で reject。                                                                        |
| 同じ Installation が同じ path を再 deploy する     | current projection を新しい Deployment の output に置き換える。古い snapshot は inactive。            |
| 同じ Installation が root `publish` を消す         | その Installation が owner の active projection を off にする。Deployment history は残す。            |
| 同じ Installation が path を変更する               | 旧 path を off にし、新 path を activate する。新 path が既に使われていれば apply/projection は失敗。 |
| 別 Installation が同じ path を publish する        | default は conflict。既存 owner を自動で off にせず reject / blocked にする。                         |
| operator-reserved path に workload が publish する | policy violation として reject。                                                                      |
| rollback で以前の path を再 activate する          | その path が空いていれば activate。別 owner が active なら rollback/projection は conflict。          |
| Installation delete / disable                      | その Installation が owner の active projection を off にする。                                       |

競合を解消する方法は、既存 owner が root `publish` を消す、Installation を disable/delete する、または operator/admin が明示的な transfer
/ disable 操作を行うことです。AppSpec だけで別 owner の active entry を奪うことはできません。

operator が root `publish` declaration を Space-visible inventory に投影する場合、projection は `(Space, path)` の compare-and-set
として扱います。同時に 2 つの apply が同じ path を activate しようとした場合、片方だけが成功し、もう片方は conflict
として失敗または blocked 状態になります。どちらの場合も、`listen.path` から見える active entry は常に 1 つです。

## Service Material

platform service entry は material shape、sensitivity、access metadata を持ちます。material vocabulary は Takosumi 公式型カタログまたは operator-adopted catalog が提供し、実際の credential、endpoint、authorization は operator implementation が materialize します。

実装側の record 例:

```yaml
PlatformServiceDeclaration:
  snapshotId: svcsnap_...
  path: identity.primary.oidc
  spaceId: space_acme_prod
  materialContract: identity.oidc@v1
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

public Deployment output は [Installer API](./installer-api.md#deployment) が定義する non-secret field だけを返します。raw credential は operator の secret delivery に残します。

## 関連ページ

- [Takosumi core 仕様](./core-spec.md)
- [manifest](./manifest.md)
- [アクセスモード](./access-modes.md)
- [Takosumi 公式型カタログ仕様](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
