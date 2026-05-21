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
  web:
    kind: worker
    spec:
      routes:
        - notes.example.local/*
```

| Field | Required | 説明 |
| --- | --- | --- |
| `apiVersion` | yes | current AppSpec version。値は `"v1"`。 |
| `metadata` | yes | AppSpec 自体の id / name / labels。 |
| `components` | yes | runtime / resource / connection intent の map。 |

unknown root field は reject されます。root に `kind:` は書きません。

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
  labels:
    team: platform
```

`metadata.id` は AppSpec の stable id です。Space や install source は AppSpec
field ではなく、Installer API / CLI の input として渡します。

## `components`

component は名前付き map entry です。各 component が使える公開 field は次の
5 つです。

| Field | Required | 説明 |
| --- | --- | --- |
| `kind` | yes | component kind。short alias または operator が解決できる kind URI。 |
| `spec` | no | kind ごとの open object。routes や image などはここに入る。 |
| `publish` | no | component output を namespace path に登録する。 |
| `listen` | no | namespace path から material を受け取る。 |
| `build` | no | source から artifact を作る最小 recipe。 |

`spec` の中身は kind ごとの convention です。AppSpec contract は `spec` の内部
field を増やしません。

## `build`

`build` は apply 前に artifact を作るための最小 recipe です。

```yaml
components:
  web:
    kind: worker
    build:
      command: npm run build
      output: dist/worker.js
```

`command` は source root を基準に実行されます。`output` は生成された artifact
path です。CI、scheduler、workflow runner そのものは kernel の責務ではなく、
AppSpec source を Installer API に渡す upstream automation として扱います。

## `publish`

`publish` は component が作った material を namespace path に登録します。

```yaml
components:
  db:
    kind: postgres
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
        prefix: DB_
```

`as` は注入方法です。一般的には `env`、`mount`、`target` のような値を使います。
`prefix` や `mount` の扱いは kind / materializer convention に従います。

`publish` / `listen` が作る依存 graph に cycle がある場合、Installation 作成や
Deployment apply は fail-closed で失敗します。

## 書かないもの

AppSpec は small contract です。次の情報は AppSpec に書きません。

| 書かないもの | 置き場所 |
| --- | --- |
| Space / organization / actor | Installer API / token claims / operator account-plane |
| Git URL / source pin | Installer API / CLI input / Deployment record |
| provider credential | operator config / runtime-agent host |
| plugin selection | operator bootstrap / `createPaaSApp({ plugins })` |
| billing / OIDC issuer / signup UI | operator account-plane |
| workflow / schedule / webhook | upstream automation that submits AppSpec source |

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
    publish:
      - com.example.notes.assets

  web:
    kind: worker
    build:
      command: npm run build
      output: dist/worker.js
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
      com.example.notes.assets:
        as: env
        prefix: ASSETS_
    spec:
      routes:
        - notes.example.local/*
```

## 次に読む

- [Installer API](./installer-api.md)
- [Provider Plugins](./providers.md)
- [Kind Catalog](./kind-catalog.md)
- [Runtime-Agent API](./runtime-agent-api.md)
