# AppSpec (`.takosumi.yml`) {#appspec-takosumi-yml}

AppSpec は Takosumi が読む source root の 1 ファイルです。Takosumi は AppSpec
を検証し、Space に Installation を作り、apply ごとに Deployment を記録します。

## Root Fields

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

component は名前付き map entry です。各 component が使える公開 field は次の 4
つです。

| Field     | Required | 説明                                                                   |
| --------- | -------- | ---------------------------------------------------------------------- |
| `kind`    | yes      | opaque component kind string。alias / URI の意味は operator が決める。 |
| `spec`    | no       | kind ごとの open object。routes や image などはここに入る。            |
| `publish` | no       | component output を namespace path に登録する。                        |
| `listen`  | no       | namespace path から material を受け取る。                              |

`kind` は operator が解決する component type です。`worker`、`web-service`、
`postgres`、`object-store`、`custom-domain` などの alias は operator の alias
map により URI へ解決されます。takosumi.com の例は
[Reference Kind Examples](./kind-registry.md) にまとめています。

`spec` の中身は selected kind / materializer の convention です。

source を build / prepare する手順は operator build service 側の handoff
convention に置きます。例は [Build service handoff](./build-spec.md) を参照。

AppSpec には apply できる intent だけを書きます。

## Source File References

worker や static asset のように source 内の file を必要とする kind は、
kind-specific な `spec` の中で source-root-relative path を受け取ります。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

`spec.entrypoint` は worker kind convention の例です。selected worker
implementation が prepared source snapshot 内の path として読みます。

build が必要な場合、build service は先に source tree を準備し、prepared source
snapshot として Installer API に渡します。AppSpec 側には build 後 snapshot 内で
runtime / materializer が読む path をそのまま書きます。

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

string list の `publish` は component の default output を namespace path に
bind します。named output や複数 output は kind-specific `spec` または
materializer convention が定義します。consumer は path を直接参照せず、`listen`
で受け取ります。

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
`access` を指定しない場合、required access mode は consumer kind / materializer
convention から解決されます。AppSpec author が指定できる distribution では、
`access: read | read-write | admin | invoke-only | observe-only` のいずれかに
制限されます。

`publish` / `listen` が作る依存 graph に cycle がある場合、Installation 作成や
Deployment apply は fail-closed で失敗します。

## 周辺情報の置き場所

AppSpec は apply intent に集中します。周辺情報は次の surface で渡します。

| 情報                              | Surface                                            |
| --------------------------------- | -------------------------------------------------- |
| Space / organization / actor      | Installer API / token claims / operator context    |
| Git URL / source pin              | Installer API / CLI input / Deployment record      |
| provider credential               | operator config / runtime-agent host               |
| implementation selection          | operator bootstrap / implementation binding config |
| build recipe / container command  | operator build service / CI                        |
| billing / OIDC issuer / signup UI | operator account-plane                             |
| workflow / schedule / webhook     | automation that submits source to Installer API    |

current AppSpec は `apiVersion`、`metadata`、`components` を root field とし、
component connection は `publish` / `listen` で表現します。

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
      entrypoint: dist/worker.mjs
```

## 次に読む

- [Installer API](./installer-api.md)
- [Build service handoff](./build-spec.md)
- [Provider Implementations](./providers.md)
- [Reference Kind Examples](./kind-registry.md)
- [Runtime-Agent API](./runtime-agent-api.md)
