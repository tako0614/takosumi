# プラットフォームサービス {#platform-services}

## operator が提供するサービスとは

プラットフォームサービスは、operator（Takosumi を運用する主体）が Space に
公開するサービスです。OIDC 認証、billing API、shared database などが典型例
です。manifest を書くアプリ開発者は、これらのサービスを component 間接続と
同じ `listen.from` の仕組みで受け取れます。

manifest `listen.from` はプラットフォームサービス path を扱えます。これにより、
manifest 外の出力データも component-local な publish の出力と同じ依存関係の
記法に参加できます。

manifest author は path を `listen.<binding>.from` に直接書きます。

次の例は、operator profile が `worker` という省略名を kind の定義に対応付けて
いる前提です。

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        from: publisher.identity.primary
        as: secret-env
        prefix: IDENTITY
        required: true
```

プラットフォームサービスも component-local な publish の出力と同じ依存関係の記法
を使います。publisher が Space に path を公開し、component がその path を listen
します。

### listen の YAML 例

```yaml
components:
  web:
    kind: worker
    listen:
      # 同一 manifest 内の component から受け取る（2 segment）
      db:
        from: db.connection
        as: secret-env
        prefix: DB
      # operator が提供するプラットフォームサービスから受け取る（3 segment 以上）
      identity:
        from: operator.identity.oidc
        as: secret-env
        prefix: OIDC
        required: true
```

## 参照 grammar

`listen.<binding>.from` は 1 つの plain dotted reference grammar を使います。

| Shape                        | 意味                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `component.publication`      | 同一 manifest 内の component の publish 出力。ちょうど 2 segment。 |
| `publisher.area.name[.more]` | プラットフォームサービス path。3 segment 以上。                     |

component name と publication name は `.` を含めないため、2 segment reference と
3 segment 以上の platform service path は曖昧になりません。

Platform service path grammar:

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

ルール:

- minimum 3 segments。
- maximum 8 segments。
- maximum 255 characters。
- empty segment は invalid。
- first segment は publisher root。

## Publisher root

first segment は、その path を提供する distribution を表します。Takosumi core
は grammar と exact-match semantics を定義します。installer は target Space に
見える operator 提供の有効なサービス一覧に対して valid path を解決します。
root naming と path inventory は distribution spec で定義します。

| Publisher root example | 提供元                           | Example path              |
| ---------------------- | -------------------------------- | ------------------------- |
| `operator`             | Operator profile                 | `operator.identity.main`  |
| `takos`                | Product distribution catalog     | `takos.memory.default`    |
| `acme`                 | Organization or private operator | `acme.database.reporting` |

root は Space-scoped です。1 つの Space では、path ごとに active visible な宣言
は 1 つだけです。同じ path の duplicate visible な宣言がある場合、apply は 409
`failed_precondition` で失敗します。Product distribution は、自分が publish する
root と、その path の裏側にある出力の形式を自分の distribution / catalog docs
に書きます。

root の有効化は operator-profile の状態です。

- `operator` は、その Space の active operator profile が提供する root。
- `takos` などの product root は、operator profile がその product distribution /
  catalog を Space に有効化した場合だけ visible。
- `acme` などの organization / private root は、account layer または private
  operator policy が管理する。
- 1 つの Space で 2 つの distribution が同じ root を使うことはできません。
  operator profile が explicit delegation rule を持たない場合、曖昧な root
  はリソースの作成・更新前に 409 `failed_precondition` です。

## 解決

Resolution は Space-scoped です。同じ path でも別 Space では別の宣言を指せます。

1. operator は target Space に visible なプラットフォームサービスの宣言を集める。
2. active visible な宣言は `(Space, path)` で unique でなければならない。同じ
   path に複数 visible な宣言があればリソースの作成・更新前に 409
   `failed_precondition`。
3. 3 segment 以上の `listen.from` value は path の exact match で解決する。
4. 選択された宣言の snapshot は Deployment の記録に残す。
5. path が absent で `required: true` の場合、リソースの作成・更新前に apply が
   失敗する。
6. path が absent で `required` が omitted または false の場合、その binding は
   absent。
7. kind-specific `spec` field が absent optional binding を参照する場合、採用
   した kind の定義が degraded behavior を明示し、その degradation を実装 /
   operator の Deployment の記録に残す場合だけ許容できる。

## 宣言と出力データ

Core は dotted `listen.from` path を解決します。2 segment は same-manifest の
publish 出力、3 segment 以上は Space で使えるプラットフォームサービスです。
型カタログは出力データの語彙と access metadata を提供します。operator または
product distribution spec は publisher root と concrete path を定義し、operator
profile が選択された宣言を実体化します。

実装では通常、「何が使えるか」と「何が実体化されたか」を分けて記録します。
次の record は operator 実装が Deployment の記録として持てる例です。

```yaml
PlatformServiceDeclaration:
  snapshotId: pubsnap_...
  publicationPath: publisher.area.name
  spaceId: space_acme_prod
  materialContract: some.material@v1
  sensitivity: restricted
  accessModes: [read, invoke-only]
  safeDefaultAccess: null
```

```yaml
PublicationMaterialization:
  linkId: link_inst_abc_binding
  publicationSnapshotId: pubsnap_...
  publicationPath: publisher.area.name
  endpointRefs: []
  secretRefs: []
  authorizationRefs: []
```

`materialContract`、`sensitivity`、`accessModes` は型カタログと operator
policy から来ます。注入モードは manifest `listen.as` が選びます。型カタログの
metadata は互換語彙を提供し、operator が選んだ実装と policy が実体化 / 注入の
振る舞いを定義します。

実装 / operator ledger は、`listen` がプラットフォームサービスを解決したときに
選択された宣言と実体化の記録を残します。public Deployment output は
[Installer API](./installer-api.md#deployment) が定義する non-secret な出力
データ field だけを公開します。

## Catalog と operator との関係

- Takosumi Kind カタログは `identity.oidc@v1` などの再利用可能な出力データの
  語彙を [型カタログ仕様](./type-catalog.md) で定義します。
- operator profile は Space で visible なプラットフォームサービス path を決めます。
- product distribution は再利用可能な product の出力データや service を ship
  する場合、自分の root 下に product-owned path を publish できます。
- Takosumi Cloud は自分の concrete path を自分の distribution 仕様で定義します。
  入口は [Takosumi Cloud](./takosumi-cloud.md) です。

## 関連ページ

- [Takosumi core 仕様](./core-spec.md)
- [manifest](./manifest.md)
- [アクセスモード](./access-modes.md)
- [Takosumi Kind カタログ仕様](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
