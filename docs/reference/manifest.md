# Manifest (`.takosumi.yml`) {#appspec-takosumi-yml}

source root に置く 1 ファイルです。root field は `apiVersion` / `metadata` /
`components` だけです。

manifest は component の接続グラフです。component は `kind` でサービスの種類
(worker / postgres / gateway など) を選び、`spec` に kind ごとの入力を書き、
`publish` と `listen` で component 間の接続を宣言します。

```text
┌─────────────┐  publish   ┌─────────────┐  listen    ┌─────────────┐
│  postgres   │──connection──▶│   worker    │──from:db───▶│  (inject)   │
│  kind: postgres │           │  kind: worker │           │  as: secret-env │
└─────────────┘             └──────┬──────┘           └─────────────┘
                                   │ publish: http
                                   ▼
                            ┌─────────────┐
                            │   gateway   │  listen from: web.http
                            │  kind: gateway │  as: upstream
                            └─────────────┘
```

Installer API は caller から受け取った `spaceId`（Takosumi は値を解釈しない）
の中で source を読み、Installation / Deployment を記録します。

## ルート項目

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
```

| Field        | Required | 説明                                            |
| ------------ | -------- | ----------------------------------------------- |
| `apiVersion` | yes      | current manifest version。値は `"v1"`。          |
| `metadata`   | yes      | manifest 自体の id / name と optional metadata。 |
| `components` | yes      | サービスやリソースの定義を並べる map。           |

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
  description: Team notes app
  publisher: Example Inc.
  homepage: https://example.com/notes
```

| Field         | Required | 説明                                                           |
| ------------- | -------- | -------------------------------------------------------------- |
| `id`          | yes      | manifest の stable identifier。reverse domain notation を推奨。 |
| `name`        | yes      | 人間向けの表示名。                                             |
| `description` | no       | 人間向けの短い説明。                                           |
| `publisher`   | no       | publisher / vendor 名。                                        |
| `homepage`    | no       | app や publisher の URL。                                      |

## `components`

| Field     | Required | 説明                                                                             |
| --------- | -------- | -------------------------------------------------------------------------------- |
| `kind`    | yes      | component の種類を示す文字列。省略名 (`worker` など) や URI を使え、意味は operator が決める。 |
| `spec`    | no       | kind-owned inputs。worker entrypoint や gateway listener/path rules などはここ。 |
| `publish` | no       | component が外に出す出力（publish の出力）を定義する。                           |
| `listen`  | no       | 他の component の publish の出力や、プラットフォームサービスを受け取る。          |

alias 例は [Takosumi Kind カタログ仕様](./type-catalog.md)。 このページの短い
alias (`worker` / `postgres` / `gateway` など) は、operator profile が short
alias map を定義している場合の例です。

component name、publication name、listen binding name は `[a-z][a-z0-9-]{0,62}`
に揃える。`.` は `component.publication` reference 用に reserved であり、map key
には使いません。

## ソースファイル参照

worker や static asset のように source 内の file を必要とする kind は、
kind-specific `spec` の中で source-root-relative path を受け取ります。source
path は git、prepared、local のどの source kind でも同じ grammar
です。選択された kind の定義が source-file reference として印を付けた `spec`
field には、リソースの作成・更新の前に共通 grammar と source-kind safety rules
を適用します。

- POSIX relative path として解釈する。
- `/` で始めない。
- NUL、空 segment、`.`、`..` を含めない。
- normalized path が source root の外を指す場合はリソースの作成・更新前に
  reject する。

resolution rule は source kind ごとに異なりますが、同じ境界を守ります。

- `git`: path は resolved commit tree に対して解決します。tree entry が symlink
  の場合、selected implementation が data として扱うか、resolved target が
  source root 内に残る場合だけ受け付けます。
- `prepared`: archive entry name、symlink、hardlink、duplicate normalized path、
  archive root 外への escape はリソースの作成・更新前に reject します。
- `local`: path は kernel process から local source tree に対して解決します。
  symlink / hardlink realpath は local source root 内に残る必要があります。

`local` は portable byte pin を持ちません。`manifestDigest` が guard するのは
`.takosumi.yml` bytes です。runtime file bytes まで portable に固定したい場合は
`git` または `prepared` source を使います。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

## `publish`

`publish` は component が外に出す出力データに名前を付けます。出力の形式は
consumer が受け取れる型で、例として DB connection、HTTP endpoint、object store
bucket、event channel などがあります。`env` / `secret-env` / `upstream` は
`listen.as` で選ぶ注入モードです。外部の publish の出力も同じ `listen.from` で
受け取ります。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding
```

| Field | Required | 説明                                                   |
| ----- | -------- | ------------------------------------------------------ |
| `as`  | yes      | 出力の形式の省略名 / URI。例: `service-binding`。 |

`as` が absolute URI ならその値を出力の形式の識別子として使います。
それ以外の文字列は省略名として、Takosumi 公式型カタログまたは operator が採用
した型カタログの語彙に対して exact match で検証します。未解決の値はリソースの
作成・更新前に apply error として拒否されます。

## `listen`

```yaml
components:
  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
```

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

| Field      | Required | 説明                                                                                                 |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `from`     | yes      | 同一 manifest の `component.publish名` またはプラットフォームサービス path。                                  |
| `as`       | yes      | consumer 側の注入モード。出力データ、consumer slot metadata、operator policy で検証する。         |
| `prefix`   | no       | env / secret-env など prefix を持つ projection 用。                                                  |
| `mount`    | no       | file / volume mount など path を持つ projection 用。                                                 |
| `required` | no       | platform service path が未解決なら apply を失敗させる。                                          |

`listen.from` は 1 つの plain dotted reference grammar を使います。ちょうど 2
segment (`db.connection`) は同一 manifest の `component.publish名` を指します。
3 から 8 segment (`publisher.identity.primary`) は Space で使える
[プラットフォームサービス](./external-publications.md) を指します。component name
と publish 名は `.` を含めないため、2 つの形式は曖昧になりません。

`as` の値 (`env` / `secret-env` / `upstream` など) と、`prefix` / `mount` の意味
は出力の形式、consumer kind schema の slot metadata、operator policy が
組み合わせて検証します。manifest core は source reference、local binding name、
closed key grammar を扱います。

`required` はプラットフォームサービス path 用の option です。Two-segment
`component.publish名` reference は常に required なので、`required` を付けた
local reference は invalid です。

### Apply 前のバリデーション

リソースの作成・更新の前に、operator が提供する kind の定義、出力の形式、
プラットフォームサービスの有効なサービス一覧、policy を使って検証します。
未解決 source、未対応の注入、secret を plain env に落とすような unsafe な注入、
出力の形式の version mismatch は apply error として拒否されます。実装または
operator ledger には選択された publish の出力 / プラットフォームサービスの
snapshot と注入モードが記録されます。public Deployment response は
[Installer API](./installer-api.md#deployment) が定義する non-secret `outputs`
を保証します。

同一 manifest 内の cycle は apply error として拒否。2 segment の
`component.publish名` ref は常に required。3 segment 以上のプラットフォーム
サービス path ref は default optional (`required: true` で未解決を apply error
に昇格)。

optional なプラットフォームサービスが absent になった場合、その local binding
は存在しません。kind-specific `spec` がその binding を必須の対象として参照して
いる場合は apply error です。採用した kind の定義が明示的に degraded behavior
を定義し、その degradation を実装 / operator の Deployment の記録に残す場合
だけ、absent optional binding を許容できます。

## Runtime HTTP 公開

public app endpoint も通常の component 接続です。HTTP route / TLS / public
hostname は、operator が採用した ingress の kind の定義の `spec` と、通常の
`listen` / `publish` で表現します。workload が publish する `web.http` は
upstream の出力データです。gateway / ingress component がその出力データを
listener 設定と operator activation で public reachability に接続します。

次の例は、operator profile が `worker` / `gateway` alias を採用済み kind の定義
URI に map している場合の kind 定義に従う `spec` 例です。`listeners` / `routes`
は manifest core field ではありません。gateway schema の詳細は
[HTTP 公開](./http-exposure.md) と
[Takosumi Kind カタログ仕様](./type-catalog.md#gateway-portable-subset)
を参照してください。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: notes.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

```text
install / deploy:
  manifest -> Installer API -> Deployment record / outputs

runtime request:
  client -> provider-native listener/route -> workload
         <- same provider data plane <- response
```

`host` は gateway の kind 定義に従う ingress input です。host の省略時挙動、
reservation、custom-domain proof、DNS ownership proof、TLS provisioning は採用
した kind の定義、operator policy、provider flow が扱います。Gateway / ingress
component は「どの HTTP の出力データを、どの gateway の kind 定義の spec で公開したい
か」を書く場所です。`routes[].to` は `listen` binding key を指します。この例では
binding key は `app`、injection mode は `upstream` です。provider object
ID、DNS verification record、TLS certificate handle、generated object ref は
deploy record に置きます。workload が読む runtime
file path は workload component の kind-specific `spec` に置きます。runtime
request は provider data plane が処理します。

gateway listener の `host` 省略時の意味は、採用した kind の定義と operator
policy が定義します。operator が default public host を割り当てた場合、その URL
は gateway の public な publish の出力と Deployment の記録に反映されます。

## 周辺情報の置き場所

| 情報                             | Surface                                              |
| -------------------------------- | ---------------------------------------------------- |
| Space / organization / actor     | Installer API / token claims / operator context      |
| Git URL / source pin             | Installer API / CLI input / Deployment record        |
| local source path                | dev / operator-local Installer API input             |
| build recipe / container command | operator build service / CI config outside manifest   |
| runtime が読む file path         | kind-specific `spec`                                 |
| provider credential              | operator / provider configuration                    |
| implementation selection         | operator profile / implementation configuration |
| identity / billing / signup UI   | operator profile / account layer docs           |
| workflow / schedule / webhook    | automation that submits source to Installer API      |

## 完全な例

この例も short alias map を定義した operator profile を想定しています。
`public.spec.routes` は official `gateway` の kind 定義の catalog-owned schema
です。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  assets:
    kind: object-store
    spec:
      name: notes-assets
    publish:
      bucket:
        as: object-store

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
      assets:
        from: assets.bucket
        as: secret-env
        prefix: ASSETS
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: notes.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

## 次に読む

- [Takosumi Kind カタログ仕様](./type-catalog.md)
- [プラットフォームサービス](./external-publications.md)
- [Takosumi Cloud](./takosumi-cloud.md)
- [Installer API](./installer-api.md)
- [HTTP 公開](./http-exposure.md)
- [Build service 境界](./build-spec.md)
