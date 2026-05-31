# Manifest (`.takosumi.yml`) {#appspec-takosumi-yml}

manifest は source root に置く 1 ファイルです。Takosumi はこのファイルを読んで
AppSpec を作り、Installation と Deployment を記録します。

AppSpec の構造は小さく保ちます。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Notes
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
publish:
  api:
    output: web.http
    kind: http-endpoint
    path: acme.notes.api
```

`components` は同じ manifest 内の component graph です。component は `kind`
で種類を選び、`spec` に kind ごとの入力を書きます。component
同士の確定的な接続は `connect`、manifest 外の platform service は
`listen`、Installation output として記録する publication declaration は root
`publish` で表します。

AppSpec の selector は `kind` に揃えます。component の `kind`
は「何を作るか」、`publish.kind` / `listen.kind` は「どの kind
の出力データを offer / consume するか」です。manifest field としての `type`
は使いません。`type` という語は JSON Schema、JSON-LD `@type`、TypeScript
の型名の文脈だけで使います。文書上は読みやすさのために component kind と
material kind を呼び分けますが、manifest に現れる selector field はどちらも
`kind` です。

判断ルールは次の 3 つです。

| やりたいこと                                       | 書き方                                           |
| -------------------------------------------------- | ------------------------------------------------ |
| 同じ manifest 内の component output に接続する     | `connect.<binding>.output: component.outputSlot` |
| Space 内の確定した 1 つの publication に接続する   | `listen.<binding>.path: owner.area.name`         |
| MCP server のような見えるもの全部を discovery する | `listen.<binding>.kind` + labels + `many: true`  |

`path` は URL path ではなく、Space 内で 1 つの publication を指す stable
name です。同じ Space の同じ `path` は active provider を 1 つだけ持てます。
集合として discovery したい publication は `path` を付けず、`kind` と
`labels` で選びます。つまり、`path` は 1 つの対象を名指しする field であり、
「同じ kind のものを全部」という意味は持ちません。

## ルート項目

| Field        | Required | 説明                                                                 |
| ------------ | -------- | -------------------------------------------------------------------- |
| `apiVersion` | yes      | current manifest version。値は `"v1"`。                              |
| `metadata`   | yes      | manifest 自体の id / name と optional metadata。                     |
| `components` | yes      | component 定義の map。                                               |
| `publish`    | no       | component output を Installation output publication として記録する。 |

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Notes
  description: Team notes app
  publisher: Example Inc.
  homepage: https://example.com/notes
```

| Field         | Required | 説明                                                            |
| ------------- | -------- | --------------------------------------------------------------- |
| `id`          | yes      | manifest の stable identifier。`[a-z][a-z0-9-]{0,62}` segment を 1-5 個 `.` でつなぐ relaxed reverse-DNS。 |
| `name`        | yes      | 人間向けの表示名。                                              |
| `description` | no       | 人間向けの短い説明。                                            |
| `publisher`   | no       | publisher / vendor 名。                                         |
| `homepage`    | no       | app や publisher の URL。                                       |

## `components`

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true
```

| Field     | Required | 説明                                                                       |
| --------- | -------- | -------------------------------------------------------------------------- |
| `kind`    | yes      | component の種類。省略名 (`worker`) や URI を使え、operator が解決する。   |
| `spec`    | no       | kind-owned inputs。worker entrypoint や gateway listener/path rules など。 |
| `connect` | no       | 同じ manifest 内の component output を、この component に接続する。        |
| `listen`  | no       | Space-visible publication を、この component に接続する。                  |

このページの `worker` / `postgres` / `gateway` などの短い値は、operator
distribution が alias map を用意している前提の例です。解決後の kind URI が
`spec` schema、output slot、接続の互換性を所有します。

component name、binding name、root publish name は `[a-z][a-z0-9-]{0,62}`
に揃えます。`.` は `component.output` と platform service path
の区切りに使います。

## Source File Reference

worker や static asset のように source 内の file を必要とする kind は、
kind-specific `spec` の中で source-root-relative path を受け取ります。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

source path は POSIX relative path として扱います。`/` で始めず、NUL、空
segment、 `.`、`..` を含めず、normalized path が source root
の外へ出ない必要があります。 `git` source では resolved commit tree、`prepared`
source では archive entry、 `local` source では kernel process から見える local
tree に対して解決します。

`local` は portable byte pin を持ちません。runtime file bytes
まで固定したい場合は `git` または `prepared` source を使います。

## `connect`

`connect` は同じ manifest 内の確定的な接続です。producer
側に追加の宣言を書く必要は ありません。consumer が
`output: component.outputSlot` を参照すると、installer は producer を先に apply
し、その output slot を materialize して consumer に渡します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small

  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
```

| Field    | Required | 説明                                                               |
| -------- | -------- | ------------------------------------------------------------------ |
| `output` | yes      | 同一 manifest の component output。形式は `component.outputSlot`。 |
| `inject` | yes      | consumer runtime への渡し方。例: `env`, `secret-env`, `upstream`。 |
| `prefix` | no       | env / secret-env など prefix を持つ projection 用。                |
| `mount`  | no       | config-mount など path を持つ projection 用。                      |

`output` は 2 segment です。`db.connection` は `db` component の `connection`
output slot を指します。output slot の意味と material shape は kind の定義と
operator の implementation binding が決めます。

同じ manifest 内の `connect` cycle は apply 前に拒否されます。`connect` は常に
required です。

## `listen`

`listen` は Space に見える publication を component に接続します。account
plane、operator distribution、product distribution、他の Installation などが出す
service material を受け取るための入口です。確定した対象は
`path`、未確定の対象や複数候補は `kind` と `labels` で選びます。

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

| Field      | Required | 説明                                                                                               |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| `path`     | no       | exact Space-visible publication path。例: `identity.primary.oidc`。                                |
| `kind`     | no       | material kind selector。`path` が無い場合は必須。`path` と併用すると互換性 assertion になる。      |
| `labels`   | no       | `kind` discovery を絞り込む label selector。                                                       |
| `many`     | no       | `true` の場合、一致した publication 全部を collection material として渡す。`path` とは併用しない。 |
| `inject`   | yes      | consumer runtime への渡し方。                                                                      |
| `prefix`   | no       | env / secret-env など prefix を持つ projection 用。                                                |
| `mount`    | no       | config-mount など path を持つ projection 用。                                                      |
| `required` | no       | 解決できない場合に apply を失敗させる。                                                            |

`path` は 3 から 8 segment の dotted path です。2 segment の component output は
`connect` で参照します。platform service / publication の具体的な path と
lifecycle は、それを 提供する distribution の仕様に置きます。`kind` は component
`kind` と同じ語彙ルールを使う opaque alias / URI で、ここでは material kind
を指します。

`path` と `kind` は役割が違います。`path` は 1 つの対象を exact match
する名前です。`kind` は discovery selector です。MCP server のように Space
内に複数存在してよいものは path を必須にせず、`kind: mcp-server@v1` と
`many: true` で受け取ります。`many` を省略した場合、selector
はちょうど 1 件に解決されなければ apply error です。
`path` と `many: true` は併用しません。exact name は単一対象、`many: true`
は kind / labels selector の集合対象だけに使います。

`many: true` は Space に見える一致 publication 全部を 1 つの collection
material として渡します。0 件で `required: true` なら apply error です。0 件で
optional なら空の collection として解決します。operator は一致結果を黙って
切り捨てず、広すぎる selector を許せない場合は apply 前に失敗させます。成功時
は deterministic な順序と選択された publication identity を Deployment
に記録します。

`required` を省略した exact `listen.path` は optional です。absent の場合、その
binding は作られません。kind-specific `spec` がその binding
を必須として扱う場合は apply error になります。

## Root `publish`

root `publish` は component output を Installation output publication
として記録します。同じ manifest 内の component 接続には使いません。`path` は
optional です。stable な exact name が必要な publication だけ path を持ち、MCP
server のように discovery される material は `kind` と `labels` で公開できます。
`mcp-server@v1` は公式カタログの material kind で、path を持たない複数の MCP
server publication を `listen.kind` でまとめて発見できます。

```yaml
publish:
  api:
    output: web.http
    kind: http-endpoint
    path: acme.notes.api
  tools:
    output: web.mcp
    kind: mcp-server@v1
    labels:
      capability: docs
```

| Field    | Required | 説明                                                                                     |
| -------- | -------- | ---------------------------------------------------------------------------------------- |
| `output` | yes      | expose する component output。形式は `component.outputSlot`。                            |
| `kind`   | no       | publication の material kind。output slot から一意に分かる場合は operator が導出できる。 |
| `path`   | no       | exact name が必要な publication だけに付ける service path。                              |
| `labels` | no       | discovery 用 label。`listen.kind` と組み合わせて絞り込む。                               |

root `publish` は「HTTP に公開する」ためのショートカットではありません。HTTP
listener、 host、TLS、route rule は gateway / ingress kind の `spec`
で表します。root `publish` は materialized output を Deployment output
に記録する Installation output publication です。 他の Installation や
operator-facing workflow から解決できるかどうかは、operator / product
distribution がその declaration を Space-visible publication inventory
に投影するかで決まります。

同じ AppSpec 内で同じ `publish.path` を 2 回宣言することはできません。`path`
を持つ publication は Space-visible inventory に投影された後も、同じ Space
の同じ path に active provider は 1 つだけです。別 Installation が同じ path を
publish した場合、operator は既存 provider を自動で off にせず conflict
として扱います。`path` を持たない publication は path conflict
に参加せず、`kind` と `labels` の discovery
対象になります。切り替える場合は、既存 owner が `publish` を消す、Installation
を disable/delete する、または operator/admin が明示的に transfer / disable
します。詳細は
[プラットフォームサービス](./platform-services.md#path-uniqueness-and-conflict)
を参照してください。

つまり、`path` で名前を取る publication は競合し、`path`
を持たない publication は競合しません。集合として見つけるものに無理に path
を付ける必要はありません。

## Runtime HTTP 公開

HTTP 公開も component graph で表します。worker は HTTP output を持ち、gateway
がそれを `connect` して route / listener 設定で公開します。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
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

runtime request は backend data plane が処理します。

```text
install / deploy:
  manifest -> Installer API -> Deployment record

runtime request:
  client -> backend-native listener/route -> workload
         <- same backend data plane <- response
```

`routes[].to` は `connect` binding key を指します。この例では binding key は
`app`、injection mode は `upstream` です。default host、custom domain proof、DNS
ownership proof、TLS provisioning は gateway kind と operator policy
が扱います。

## Deployment Outputs

Deployment は apply の結果として component output material と provider outputs
を記録します。`connect` や root `publish` から参照された output slot は
materialize され、public response には secret を含まない形で入ります。backend
object ID、DNS verification record、TLS certificate handle などの operator
evidence は operator-facing ledger にも記録できます。

## 周辺情報の置き場所

| 情報                             | Surface                                              |
| -------------------------------- | ---------------------------------------------------- |
| Space / organization / actor     | Installer API / token claims / operator context      |
| Git URL / source pin             | Installer API / CLI input / Deployment record        |
| local source path                | dev / operator-local Installer API input             |
| build recipe / container command | operator build service / CI config outside manifest  |
| runtime が読む file path         | kind-specific `spec`                                 |
| backend credential               | operator / implementation binding                    |
| implementation selection         | operator distribution / implementation configuration |
| identity / billing / signup UI   | operator distribution / account layer docs           |
| workflow / schedule / webhook    | automation that submits source to Installer API      |

## 完全な例

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

  assets:
    kind: object-store
    spec:
      name: notes-assets

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
      assets:
        output: assets.bucket
        inject: secret-env
        prefix: ASSETS
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
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
publish:
  api:
    output: web.http
    kind: http-endpoint
    path: acme.notes.api
```

## 次に読む

- [Takosumi 公式カタログ仕様](./catalog.md)
- [プラットフォームサービス](./platform-services.md)
- [Installer API](./installer-api.md)
- [HTTP 公開](./http-exposure.md)
- [Build service 境界](./build-spec.md)
