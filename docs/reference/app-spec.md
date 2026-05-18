# AppSpec (`.takosumi.yml`)

> このページでわかること: source root に置く `.takosumi.yml` の全 field 仕様。

`.takosumi.yml` は Takosumi が読む唯一の AppSpec ファイルです。 source
repository の root に 1 ファイル置くだけで、 Takosumi は Space に Installation
を作り、 apply のたびに Deployment を記録します。

```text
your-repo/
└── .takosumi.yml
```

## 中核概念

Takosumi の public concept は次の 3 つだけです。

| 概念             | 表現                                            |
| ---------------- | ----------------------------------------------- |
| **AppSpec**      | `.takosumi.yml` (ユーザーが書く唯一の仕様)      |
| **Installation** | Space に入ったアプリ (= 所有 / 課金 / 現在状態) |
| **Deployment**   | 1 回の apply の結果 (= 履歴 / audit / rollback) |

仕様面の名詞はこれだけです。 これ以上の概念は実装内部に存在しても、
表面化させません。

## Envelope

```yaml
apiVersion: takosumi.dev/v1
kind: App

metadata:
  id: com.example.notes
  name: Example Notes
  description: Personal notes app
  publisher: example

components:
# ...

interfaces:
# ...

permissions:
  requested:
# ...
```

| field         | required | 型     | 説明                                          |
| ------------- | -------- | ------ | --------------------------------------------- |
| `apiVersion`  | yes      | string | 固定値 `"takosumi.dev/v1"`                    |
| `kind`        | yes      | string | 固定値 `"App"`                                |
| `metadata`    | yes      | object | App 識別子と display 用情報                   |
| `components`  | yes      | object | コンポーネント定義 (= runtime parts)          |
| `interfaces`  | no       | object | Takos / OS / Agent 等が利用する公開 interface |
| `permissions` | no       | object | Installation が要求する Takos API scope       |

unknown top-level field は reject。 `apiVersion` / `kind` は文字列で厳密一致。

## `metadata`

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
  description: Personal notes app
  publisher: example
  homepage: https://example.com/notes
```

| field         | required | 説明                      |
| ------------- | -------- | ------------------------- |
| `id`          | yes      | 一意の reverse-DNS App ID |
| `name`        | yes      | display name              |
| `description` | no       | 1 行の概要                |
| `publisher`   | no       | publisher 識別子          |
| `homepage`    | no       | App home page URL         |

## `components`

各 component は `kind` を 1 つ持ちます。 `kind` には **短い alias** (= `worker`
/ `postgres` 等) または **完全な kind URI** (= `https://takosumi.com/kinds/v1/worker`
等) を書けます。 catalog 定義は
[Component Kind Catalog](./component-kind-catalog.md) を参照してください。

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes: [/]
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
      com.example.notes.media:
        as: env
        prefix: BLOB_

  db:
    kind: postgres
    publish:
      - com.example.notes.db

  media:
    kind: object-store
    publish:
      - com.example.notes.media

  domain:
    kind: custom-domain
    spec:
      name: notes.example.com
    listen:
      com.example.notes.web:
        as: target
```

> URI 直書きの例:
>
> ```yaml
> components:
>   lambda-worker:
>     kind: https://operator.example.com/kinds/v1/aws-lambda
> ```
>
> short alias は対応する kind JSON-LD document が `aliases: ["worker"]` 等を
> 宣言している場合に限り受理され、 内部で full URI に正規化されます。

### Component common fields

| field        | required | 説明                                                                                |
| ------------ | -------- | ----------------------------------------------------------------------------------- |
| `kind`       | yes      | 短 alias または完全 URI (= JSON-LD document を直接指せる)                           |
| `spec`       | no       | kind JSON-LD の `spec` block に対応する設定 (= routes / size / certificate 等)      |
| `build`      | no       | 最小 build recipe (= artifact を得る条件、 CI workflow ではない)                    |
| `publish`    | no       | この component が出力する namespace path の list                                    |
| `listen`     | no       | listen 対象 namespace path → listen option object の map                            |

### `build` (= minimum build recipe)

`build` は **artifact を得る最小条件** を表現します。 CI workflow
ではありません。

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
```

許可される field:

| field     | required | 説明                                      |
| --------- | -------- | ----------------------------------------- |
| `command` | yes      | source root 配下で実行する shell コマンド |
| `output`  | yes      | command 後に生成される artifact path      |

許可されない概念 (= workflow / CI 機能):

- `jobs` / `steps` / `matrix` / `triggers`
- deploy pipeline / rollback pipeline
- GitHub Actions 的な DSL

build を持たない component (= `kind: postgres` / `object-store` /
`custom-domain`) は provider が直接 materialize します。

### `publish` (= namespace への出力)

`publish` は **この component が外部に出す namespace path** の list です。
他 component / 他 Installation はその path を `listen` することで material
(= 接続情報 / 環境変数原料) を受け取れます。

```yaml
components:
  db:
    kind: postgres
    publish:
      - com.example.notes.db        # 任意 path
      - com.example.notes.primary   # 同じ material を複数 path で公開してもよい
```

各 path に publish される material は、 その component の kind の JSON-LD
document が `publishes[]` で宣言します。 例えば `kind: postgres` の JSON-LD は
`{ host, port, database, username, passwordSecretRef, connectionString }`
を material として宣言します。

**Auto-namespacing**: `publish` を省略すると、 kernel が
`<app-id>.<component-name>` (= `com.example.notes.db`) を自動的に publish 経路と
して採用します。 同じ Installation 内の sibling component を listen するときに
便利です。

### `listen` (= namespace からの入力)

`listen` は **どの namespace path を受け取り、 どう注入するか** を宣言します。
`use:` edge は廃止され、 すべての component 間接続は `publish` / `listen`
ペアで表現します。

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
      com.example.notes.media:
        as: env
        prefix: BLOB_
      operator.identity.oidc:
        as: env
      com.example.notes.web:
        as: target            # custom-domain 用 (= 別 component から書く例)
```

各 entry の option:

| option   | 用途                                                                       |
| -------- | -------------------------------------------------------------------------- |
| `as`     | listen shape (= `env` / `target` / `mount` 等、 kind JSON-LD が許容形を決定)|
| `prefix` | `as: env` の際に各 material field を `${PREFIX}_*` env var に展開          |
| `mount`  | kind 固有 mount point name (= custom-domain の `target` 等の意味的 anchor) |

各 kind がどの listen shape を受理するかは、 その kind JSON-LD の
`listens` block を参照してください。

#### Auto-namespacing と sibling listen

`listen` 側でも、 同じ Installation 内の sibling component は
`<app-id>.<component>` を書く代わりに短い alias を書けます (Phase B 以降の
parser で実装予定の syntactic sugar)。 現状の正式 syntax は full path です。

#### Cycle の検出

`publish` → `listen` で作られる依存 DAG が cycle を含むと、 Installation 作成
時に `invalid_argument` (400) として reject されます。

### kind 固有 field (= `spec` block)

各 kind の `spec` field 配下に書ける構造は、 対応する JSON-LD document の
`spec` (= JSON Schema 2020-12) に従います。 抜粋:

| kind            | 主な `spec` field                                       |
| --------------- | ------------------------------------------------------- |
| `worker`        | `routes`, `compatibilityDate`, `compatibilityFlags`, `env`, `artifact` |
| `postgres`      | `version`, `size`, `storage`, `backups`, `extensions`   |
| `object-store`  | `name`, `public`, `versioning`, `region`, `lifecycle`   |
| `custom-domain` | `name`, `certificate`, `redirects`                      |

詳細は [Component Kind Catalog](./component-kind-catalog.md)。

## `interfaces` (optional)

Takos / OS / Agent layer が App を呼び出す entry point を宣言します。 component
の path にマップします。

```yaml
interfaces:
  launch:
    target: web
    path: /api/auth/launch

  mcp:
    target: web
    path: /mcp
    required: false
```

| key      | 用途                                                             |
| -------- | ---------------------------------------------------------------- |
| `launch` | Takos space launcher が叩く path                                 |
| `mcp`    | Agent layer が discover する MCP endpoint                        |
| `health` | operator が叩く health probe path (default は kernel が用意する) |

各 interface の field:

| field      | required | 説明                                         |
| ---------- | -------- | -------------------------------------------- |
| `target`   | yes      | components の key (例: `web`)                |
| `path`     | yes      | target component 内の URL path               |
| `required` | no       | `false` のとき、 missing でも apply 成功扱い |

## `permissions` (optional)

Installation が Takos product API に対して要求する scope を宣言します。 具体的な
scope は Takos product side で定義され、 Installation の materialize 時に
Takosumi が user / operator に提示します。

```yaml
permissions:
  requested:
    - logs.read.own
    - spaces:read
```

scope vocabulary は Takos / 上位 product が所有します。 Takosumi は文字列リスト
として受理して Installation に記録するだけです。

## 「plugin」 は spec 用語ではない

AppSpec には **`plugin:` field は存在しません**。 旧 design では provider
plugin URI を AppSpec に書く案がありましたが、 廃止しました。 plugin
(= materializer 実装) は operator が `createPaaSApp({ materializers: [...] })`
で渡す **実装層** であり、 manifest は **抽象 type (= kind)** のみを宣言します。
同じ kind URI に対して複数 materializer 実装が存在しうるため、 manifest 側で
特定実装を指定することは spec の責務外です。

## Source 取得

`source.git` を AppSpec に書く必要はありません。 Git URL は Install API
invocation context にあるためです。 同じ `.takosumi.yml` は次のいずれの経路でも
そのまま動きます:

- `POST /v1/installations` に `source: { kind: git, url, ref }` を渡す
- local working tree から `takosumi install ./path` で送る
- catalog 経由で `source: { kind: catalog, id }` を解決する

詳細は [Installer API](./installer-api.md) 参照。

## 削除された概念 (= 過去仕様からの clean cut)

次の概念は AppSpec には登場しません。 過去 spec を参照する場合は読み替えが必要
ですが、 移行 guide は提供しません。

| 旧概念                                                                                    | 新位置                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `.takosumi/app.yml` + `.takosumi/manifest.yml`                                            | `.takosumi.yml` 1 file に統合                |
| `.takosumi/workflows/*`                                                                   | 廃止 (workflow は manifest に内包しない)     |
| authoring/runtime 中間 manifest                                                           | 廃止 (実行結果は Deployment に記録)          |
| `retired authoring extension`, `TAKOSUMI_ARTIFACT`                                        | 廃止 (component.build の最小 recipe で十分)  |
| `${ref:...}` / `${secret-ref:...}` interpolation                                          | `publish` / `listen` に置換                  |
| `${bindings.*}` / `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` | `publish` / `listen` に統合                  |
| `use:` edge                                                                               | `publish` / `listen` に統合 (= 唯一の edge)  |
| `kind: oidc`                                                                              | takosumi-cloud が `operator.identity.oidc` を publish する model に移動 |
| `plugin:` field in manifest                                                               | 廃止 (= materializer は operator config 側)  |
| `source.git` in manifest                                                                  | API input + Deployment record に持つ         |
| runtime target metadata                                                                   | internal ledger / Deployment evidence        |
| DeploymentPlan / DeploymentSnapshot / Preview                                             | dry-run response + Deployment record で十分  |

## Cross-references

- [Component Kind Catalog](./component-kind-catalog.md) — 4 kind の spec /
  publishes / listens / outputs
- [Installer API](./installer-api.md) — 5 endpoint (dry-run / apply / rollback)
- [Architecture: Manifest model](./architecture/manifest-model.md) — AppSpec →
  Installation → Deployment の lifecycle
