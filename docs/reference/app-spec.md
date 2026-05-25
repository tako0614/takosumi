# AppSpec (`.takosumi.yml`) {#appspec-takosumi-yml}

source root の 1 ファイル。root field は `apiVersion` / `metadata` /
`components` だけです。

AppSpec は component graph です。component は `kind` で contract を選び、`spec`
に kind-specific input を書き、`publish` と `listen` で接続を宣言します。 source
の取得、Space、approval、Deployment history は Installer API と operator account
plane が分担します。Takosumi core は Installation / Deployment record を持ち、
operator account plane は account / Space / billing / approval
の文脈に投影します。

## Root Fields

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
| `metadata`   | yes      | AppSpec 自体の id / name と optional metadata。 |
| `components` | yes      | runtime / resource / connection intent の map。 |

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
| `id`          | yes      | AppSpec の stable identifier。reverse domain notation を推奨。 |
| `name`        | yes      | 人間向けの表示名。                                             |
| `description` | no       | 人間向けの短い説明。                                           |
| `publisher`   | no       | publisher / vendor 名。                                        |
| `homepage`    | no       | app や publisher の URL。                                      |

## `components`

| Field     | Required | 説明                                                                             |
| --------- | -------- | -------------------------------------------------------------------------------- |
| `kind`    | yes      | opaque component kind string。alias / URI の意味は operator が決める。           |
| `spec`    | no       | kind-owned inputs。worker entrypoint や gateway listener/path rules などはここ。 |
| `publish` | no       | component の local publication を定義する。                                      |
| `listen`  | no       | local binding を作り、publication や external publication を受け取る。           |

alias 例は [Takosumi Official Type Catalog Specification](./type-catalog.md)。
このページの短い alias (`worker` / `postgres` / `gateway` など) は、operator
profile が short alias map を定義している場合の例です。

Component name、publication name、listen binding name は `[a-z][a-z0-9-]{0,62}`
に揃える。`.` は `component.publication` reference 用に reserved であり、map key
には使いません。

## Source File References

worker や static asset のように source 内の file を必要とする kind は、
kind-specific `spec` の中で source-root-relative path を受け取ります。source
path は git、prepared、local のどの source kind でも同じ grammar です。 Core
does not inspect arbitrary open `spec` fields as paths. Once the selected
descriptor marks a field as a source-file reference, the common grammar and
source-kind safety rules below apply before implementation side effects.

- POSIX relative path として解釈する。
- `/` で始めない。
- NUL、空 segment、`.`、`..` を含めない。
- normalized path が source root の外を指す場合は provider side effect 前に
  reject する。

Resolution rules are source-kind specific but enforce the same boundary:

- `git`: path is resolved against the resolved commit tree. A tree entry that is
  a symlink is accepted only when the selected implementation treats it as data
  or its resolved target remains under the source root.
- `prepared`: archive entry names, symlinks, hardlinks, duplicate normalized
  paths, and escapes outside the archive root are rejected before provider side
  effects.
- `local`: path is resolved by the kernel process against the local source tree;
  symlink / hardlink realpaths must remain under the local source root.

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

`publish` は component-local output に名前を付け、material contract として offer
します。material contract は consumer が bind できる output の型です。例として
DB connection、HTTP upstream、object store bucket、secretRef-mediated env などが
あります。外部 publisher が offer する material も同じ `listen.from` で consume
します。

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
| `as`  | yes      | material contract alias / URI。例: `service-binding`。 |

`as` が absolute URI ならその値を material contract identity として使います。
それ以外の文字列は compact material contract term として、Takosumi official type
catalog または operator-adopted catalog の vocabulary に対して exact match で
検証します。未解決の contract は provider side effect 前に apply error として
拒否されます。

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
| `from`     | yes      | 同一 AppSpec の `component.publication` または外部 publication path。                                |
| `as`       | yes      | consumer 側 projection family。source material、consumer slot metadata、operator policy で検証する。 |
| `prefix`   | no       | env / secret-env など prefix を持つ projection 用。                                                  |
| `mount`    | no       | file / volume mount など path を持つ projection 用。                                                 |
| `required` | no       | external publication path が未解決なら apply を失敗させる。                                          |

`listen.from` has one plain dotted reference grammar. Exactly two segments
(`db.connection`) refer to a same-AppSpec `component.publication`. Three to
eight segments (`publisher.identity.primary`) refer to a Space-visible
[external publication](./external-publications.md). Component names and
publication names cannot contain `.`, so the two forms are unambiguous.

`as` の値 (`env` / `secret-env` / `upstream` など) と、`prefix` / `mount` の意味
は source material contract、consumer kind descriptor の slot metadata、operator
policy が組み合わせて検証します。 AppSpec core は source reference、local
binding name、closed key grammar を扱います。

`required` は external publication path 用の option です。Two-segment
`component.publication` reference は常に required なので、`required` を付けた
local reference は invalid です。

### Validation before apply

Resolution は provider side effect 前に、operator-supplied descriptors、
material contracts、external publication declarations、policy
を使って検証します。 未解決 source、未対応 projection、secret を plain env
に落とすような unsafe projection、contract version mismatch は apply error
として拒否されます。実装または operator ledger には選択された publication /
external publication snapshot と projection family が記録されます。public
Deployment response は [Installer API](./installer-api.md#deployment) が定義する
non-secret `outputs` を保証します。

同一 AppSpec 内の cycle は apply error として拒否。2 segment の
`component.publication` ref は常に required。3 segment 以上の external
publication path ref は default optional (`required: true` で未解決を apply
error に昇格)。

Optional external publication が absent になった場合、その local binding
は存在し ません。kind-specific `spec` がその binding
を必須の対象として参照している場合 は apply error です。adopted descriptor
が明示的に degraded behavior を定義し、その degradation を implementation /
operator evidence に記録する場合だけ、absent optional binding を許容できます。

## Runtime HTTP exposure

public app endpoint も通常の component connection です。HTTP route / TLS /
public hostname は、operator が採用した ingress descriptor の `spec` と、通常の
`listen` / `publish` で表現します。workload が publish する `web.http` は
upstream material です。gateway / ingress component がその material を listener
intent と operator activation で public reachability に 接続します。

次の例は、operator profile が `worker` / `gateway` alias を採用済み descriptor
URI に map している場合の descriptor-owned `spec` 例です。`listeners` /
`routes` は AppSpec core field ではありません。gateway schema の詳細は
[HTTP Exposure](./http-exposure.md) と
[Takosumi Official Type Catalog Specification](./type-catalog.md#gateway-portable-subset)
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
  AppSpec -> Installer API -> Deployment record / outputs

runtime request:
  client -> provider-native listener/route -> workload
         <- same provider data plane <- response
```

`host` は希望する public ingress 名です。operator は domain policy、reservation
conflict、custom domain の DNS / ownership proof を account-plane / provider
flow で確認します。Gateway / ingress component は「どの HTTP material を、どの
listener / route intent で公開したいか」を書く場所です。`routes[].to` は
`listen` binding key を指します。この例では binding key は `app`、projection
family は `upstream` です。provider object ID、DNS verification record、TLS
certificate handle、generated object ref は retained implementation/operator
evidence に置きます。workload が読む runtime file path は workload component の
kind-specific `spec` に置きます。runtime request は provider data plane が
処理します。

gateway listener の `host` 省略時の意味は、採用した descriptor と operator
policy が定義します。operator が default public host を割り当てた場合、その URL
は gateway の public publication output と retained implementation/operator
evidence に記録されます。

## 周辺情報の置き場所

| 情報                             | Surface                                              |
| -------------------------------- | ---------------------------------------------------- |
| Space / organization / actor     | Installer API / token claims / operator context      |
| Git URL / source pin             | Installer API / CLI input / Deployment record        |
| local source path                | dev / operator-local Installer API input             |
| build recipe / container command | operator build service / CI config outside AppSpec   |
| runtime が読む file path         | kind-specific `spec`                                 |
| provider credential              | operator / provider configuration                    |
| implementation selection         | operator bootstrap / reference implementation config |
| identity / billing / signup UI   | operator distribution / account-plane docs           |
| workflow / schedule / webhook    | automation that submits source to Installer API      |

## 完全な例

この例も short alias map を定義した operator profile を想定しています。
`public.spec.routes` は official `gateway` descriptor の catalog-owned schema
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

- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [External publications](./external-publications.md)
- [Takosumi Cloud](./takosumi-cloud.md)
- [Installer API](./installer-api.md)
- [HTTP Exposure](./http-exposure.md)
- [Build service handoff](./build-spec.md)
