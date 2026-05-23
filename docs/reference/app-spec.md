# AppSpec (`.takosumi.yml`) {#appspec-takosumi-yml}

AppSpec は Takosumi が読む source root の 1 ファイルです。Takosumi は AppSpec
を検証し、Space に Installation を作り、apply ごとに Deployment を記録します。

## Root shape

AppSpec root は 3 field だけです。

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

unknown root field は reject されます。root に `kind:` は書きません。

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
```

`metadata.id` は AppSpec の stable id です。Space や install source は AppSpec
field ではなく、Installer API / CLI の input として渡します。

## `components`

component は名前付き map entry です。各 component が使える公開 field は次の 4
つです。

| Field     | Required | 説明                                                                   |
| --------- | -------- | ---------------------------------------------------------------------- |
| `kind`    | yes      | opaque component kind string。alias / URI の意味は operator が決める。 |
| `spec`    | no       | kind ごとの open object。routes や image などはここに入る。            |
| `publish` | no       | component output を namespace path に登録する。                        |
| `listen`  | no       | namespace path から material を受け取る。                              |

Takosumi AppSpec v1 は公式 component kind を 1 つも定義しません。`worker`、
`web-service`、`postgres`、`object-store`、`custom-domain` は Takos reference
registry が公開する alias であり、Takosumi spec の contract-owned kind
ではありません。operator が alias map を 渡した場合だけ short alias が URI
に解決されます。

`spec` の中身は kind ごとの convention です。AppSpec contract は `spec` の内部
field を増やしません。

component の `build` field は AppSpec v1 の公開 field ではありません。

source から artifact を作る手順は [BuildSpec](./build-spec.md) と build service
に置きます。

AppSpec には apply できる intent だけを書きます。

## Artifact reference

worker や static asset のように runtime artifact を必要とする kind は、
kind-specific な `spec` の中で artifact descriptor を受け取ります。

```yaml
components:
  web:
    kind: worker
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

`spec.artifact` は AppSpec root の field ではなく、Takos reference worker kind
の convention です。provider に渡る resolved AppSpec bundle では uploaded
artifact の `kind` / `hash` を持つ descriptor でなければなりません。

artifact の生成、upload、provenance 記録は build service / CI / operator
automation の責務です。source 側で build output path を扱う場合も、Installer API
に渡す resolved bundle では digest descriptor に変換します。

## `publish`

`publish` は component が作った material を namespace path に登録します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.notes.db
```

publish された material の shape は kind と materializer が決めます。consumer は
path を直接参照せず、`listen` で受け取ります。

## `listen`

`listen` は namespace path から material を受け取り、component に注入します。

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
```

`as` は注入方法です。一般的には `env`、`mount`、`target` のような値を使います。
`prefix` や `mount` の扱いは kind / materializer convention に従います。

`publish` / `listen` が作る依存 graph に cycle がある場合、Installation 作成や
Deployment apply は fail-closed で失敗します。

## 書かないもの

AppSpec は small contract です。次の情報は AppSpec に書きません。

| 書かないもの                      | 置き場所                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| Space / organization / actor      | Installer API / token claims / operator-owned context          |
| Git URL / source pin              | Installer API / CLI input / Deployment record                  |
| provider credential               | operator config / runtime-agent host                           |
| plugin selection                  | operator bootstrap / `createPaaSApp({ kindAliases, plugins })` |
| build recipe / container command  | BuildSpec / build service / CI                                 |
| billing / OIDC issuer / signup UI | operator-owned external surface                                |
| workflow / schedule / webhook     | upstream automation that submits AppSpec source                |

過去の design にあった `use:`、root `kind: App`、top-level `interfaces`、
top-level `permissions`、top-level `routes` は current AppSpec では使いません。

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
    publish:
      - com.example.notes.db

  assets:
    kind: object-store
    spec:
      name: notes-assets
    publish:
      - com.example.notes.assets

  web:
    kind: worker
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
      com.example.notes.assets:
        as: env
        prefix: ASSETS
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

## 次に読む

- [Installer API](./installer-api.md)
- [BuildSpec](./build-spec.md)
- [Provider plugin](./providers.md)
- [Reference Kind Registry](./kind-catalog.md)
- [Runtime-Agent API](./runtime-agent-api.md)
