# AppSpec (`.takosumi.yml`) {#appspec-takosumi-yml}

AppSpec は Takosumi が読む source root の 1 ファイルです。Takosumi は AppSpec を
検証し、Space に Installation を作り、apply ごとに Deployment を記録します。
Space は operator/account-plane が所有する Installation の境界で、AppSpec の中に
は宣言しません。

AppSpec は apply したい intent に集中します。source の取得、build、credential、
provider selection、billing、workflow trigger は別の surface で扱います。

## Root Fields

AppSpec root は 3 field だけです。以下の例は takosumi.com reference alias に
opt-in した operator を想定しています。portable に書く場合は full kind URI
も指定できます。

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
| `apiVersion` | yes      | current AppSpec version。値は `"v1"`。          |
| `metadata`   | yes      | AppSpec 自体の id / name / labels。             |
| `components` | yes      | runtime / resource / connection intent の map。 |

root field はこの 3 つです。component type は各 component の `kind` に書きます。

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
```

`metadata.id` は AppSpec の stable id です。Space や install source は Installer
API / CLI の input として渡します。

## `components`

component は名前付き map entry です。各 component が使える公開 field は次の 4 つ
です。

| Field     | Required | 説明                                                                   |
| --------- | -------- | ---------------------------------------------------------------------- |
| `kind`    | yes      | opaque component kind string。alias / URI の意味は operator が決める。 |
| `spec`    | no       | kind ごとの open object。image、file path、route rule などはここ。     |
| `publish` | no       | component の local publication を定義する。                            |
| `listen`  | no       | local binding を作り、publication や namespace export を受け取る。     |

`kind` は operator が解決する component type です。`worker`、`web-service`、
`postgres`、`object-store`、`gateway` などの short alias は takosumi.com
reference descriptor examples に opt-in した operator で使えます。operator は
alias map で URI へ解決します。takosumi.com の例は
[Kind Descriptor Examples](./kind-registry.md) にまとめています。

`spec` の中身は selected kind の input です。`spec` は YAML mapping です。
Takosumi core は AppSpec の外形だけを検証します。kind-specific な意味は
descriptor / operator implementation 側で扱います。

## Source File References

worker や static asset のように source 内の file を必要とする kind は、
kind-specific `spec` の中で source-root-relative path を受け取ります。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

`spec.entrypoint` は worker kind convention の例です。selected worker
implementation が source snapshot 内の path として読みます。

build が必要な場合、build service / CI / operator automation は先に source tree
を準備し、prepared source snapshot として Installer API に渡します。AppSpec 側
には build 後 snapshot 内で runtime が読む path をそのまま書きます。

## `publish`

`publish` は component の output を local publication
として公開します。namespace path を書く場所ではありません。

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

`publish.<name>` の key は同じ AppSpec 内で参照する publication 名です。上の例
では `db.connection` が参照名になります。

| Field | Required | 説明                                                   |
| ----- | -------- | ------------------------------------------------------ |
| `as`  | yes      | material contract alias / URI。例: `service-binding`。 |

provider output から publication material への写像は AppSpec には書きません。
selected kind の descriptor と operator implementation binding
が決めます。AppSpec author は publication 名と material contract
だけを宣言します。

`publish` は component-local な宣言です。任意 namespace path への export は
component が直接書くのではなく、operator-owned namespace export の surface
で扱い ます。

## `listen`

`listen` は local binding を作り、`from` で source を指定します。

```yaml
components:
  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
```

`listen.<name>` の key は consumer 側の local binding 名です。`from` は同じ
AppSpec 内の `component.publication` か、operator-owned namespace export を指す
`namespace:<path>` です。

```yaml
components:
  web:
    kind: worker
    listen:
      oidc:
        from: namespace:operator.identity.oidc
        as: env
        prefix: OIDC
        required: true
```

| Field      | Required | 説明                                                     |
| ---------- | -------- | -------------------------------------------------------- |
| `from`     | yes      | `component.publication` または `namespace:<path>`。      |
| `as`       | yes      | consumer 側 projection。例: `env`、`mount`、`upstream`。 |
| `prefix`   | no       | `as: env` の env var prefix。                            |
| `mount`    | no       | `as: mount` の mount path。                              |
| `required` | no       | `namespace:<path>` が未解決なら apply を失敗させる。     |

`publish` / `listen` が作る同一 AppSpec 内の依存 graph に cycle がある場合、
Installation 作成や Deployment apply は fail-closed で失敗します。外部 namespace
ref は AppSpec 内の graph edge にはなりません。同一 AppSpec 内の
`component.publication` ref は常に required です。外部 `namespace:<path>` ref は
default では optional で、`required: true` のときだけ未解決を apply error
にします。OIDC client material や database credential のように起動に必須の外部
namespace は `required: true` を付けます。optional の既定値は、observability
など無くても起動できる operator feature を soft-bind するためのものです。

## Gateway と route

HTTP route / TLS / public hostname は AppSpec root field
ではありません。`gateway` のような edge component が upstream publication を
`listen` し、route rule を kind-specific `spec` に持ちます。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
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

`web` は HTTP endpoint material を publish します。`public` gateway はその
material を `app` binding として受け取り、`spec.routes[].to` で binding 名を参照
します。gateway が materialize した public endpoint は `public.public`
publication になります。`gateway` 自体は operator が提供する kind
であり、AppSpec root に route 専用の field は増やしません。

## AppSpec に書かないもの

AppSpec は apply intent に集中します。周辺情報は次の場所で扱います。
`.takosumi.build.yml` は build service / CI の handoff convention であり、
Takosumi kernel / installer が読む public manifest ではありません。

| 情報                              | Surface                                              |
| --------------------------------- | ---------------------------------------------------- |
| Space / organization / actor      | Installer API / token claims / operator context      |
| Git URL / source pin              | Installer API / CLI input / Deployment record        |
| local source path                 | dev / operator-local Installer API input             |
| build recipe / container command  | build service / CI / `.takosumi.build.yml`           |
| runtime が読む file path          | kind-specific `spec`                                 |
| provider credential               | operator config / runtime-agent host                 |
| implementation selection          | operator bootstrap / reference implementation config |
| billing / OIDC issuer / signup UI | operator account-plane                               |
| workflow / schedule / webhook     | automation that submits source to Installer API      |

## 完全な例

この例も takosumi.com reference alias に opt-in した operator を想定しています。

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
      entrypoint: dist/worker.mjs
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
      assets:
        from: assets.bucket
        as: env
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

- [Installer API](./installer-api.md)
- [Build service handoff](./build-spec.md)
- [Provider Implementations](./providers.md)
- [Kind Descriptor Examples](./kind-registry.md)
