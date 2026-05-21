# AppSpec (`.takosumi.yml`) {#appspec-takosumi-yml}

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

## エンベロープ {#envelope}

```yaml
apiVersion: v1

metadata:
  id: com.example.notes
  name: Example Notes
  description: Personal notes app
  publisher: example

components:
# ...
```

> Wave L AppSpec apiVersion group-prefix removal 後の AppSpec root は
> `apiVersion` / `metadata` / `components` の 3 field のみ、 `apiVersion` は
> bare `"v1"` 固定。 `apiVersion: v1` 単独 で schema を discriminate するため、
> Wave K で削除した `kind: App` root field は引き続き unknown-key reject。 内部
> Component の `kind:` field (= materializer 解決の discriminator) は当然 keep。
> Wave J で 削除済の top-level `interfaces:` / `permissions:` も引き続き
> reject。 launch / health / capability-request 等の semantics は kind の open
> `spec:` field (または 別 kind の namespace pub/sub) を materializer
> が読む形で表現する (= 底は自由)。

| field        | required | 型     | 説明                                 |
| ------------ | -------- | ------ | ------------------------------------ |
| `apiVersion` | yes      | string | 固定値 `"v1"`                        |
| `metadata`   | yes      | object | App 識別子と display 用情報          |
| `components` | yes      | object | コンポーネント定義 (= runtime parts) |

unknown top-level field は reject (= root に `kind:` を含む入力は Wave K 以降
unknown-key として reject されます)。 `apiVersion` は文字列で厳密一致。 旧
`interfaces:` / `permissions:` block は Wave J で、 旧 `kind: App` root field は
Wave K で削除済 (= いずれも top-level field として宣言できない)。

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
/ `postgres` 等) または **完全な kind URI** (=
`https://takosumi.com/kinds/v1/worker` 等) を書けます。 catalog 定義は
[Kind Catalog](./kind-catalog.md#component-kinds) を参照してください。

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

> Note: 上記の `web.spec.routes` は worker materializer の慣習 field で、 worker
> kind contract には declare されません (= 「底は自由」 原則、 後述
> [launch / health / mcp endpoints, permission requests](#launch-health-mcp-endpoints-permission-requests)
> 節参照)。 別 materializer 実装は routes を別の表現で扱っても構いません。

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

### Component 共通フィールド {#component-common-fields}

| field     | required | 説明                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `kind`    | yes      | 短 alias または完全 URI (= JSON-LD document を直接指せる)                      |
| `spec`    | no       | kind JSON-LD の `spec` block に対応する設定 (= routes / size / certificate 等) |
| `build`   | no       | 最小 build recipe (= artifact を得る条件、 CI workflow ではない)               |
| `publish` | no       | この component が出力する namespace path の list                               |
| `listen`  | no       | listen 対象 namespace path → listen option object の map                       |

### `build` (= 最小 build recipe) {#build-minimum-build-recipe}

> **Wave N planned (2026-05-21 RFC stage)**: `Component.build` field は Wave N
> で **削除予定** (= Component は 4 field に minimize、 build recipe は別
> `kind: build` component に移管、 artifact は namespace pub/sub 経由で consumer
> に届く)。 詳細 design は [RFC 0001](../rfc/0001-kernel-kind-agnostic.md)
> を参照。 現状 code は本 section 通り `build:` を受理します、 RFC 完了後に
> narrative sweep 予定。

`build` は **artifact を得る最小条件** を表現します。 CI workflow
ではありません。

```yaml
components:
  web:
    kind: worker
    # Wave N (planned): `build:` field は別 `kind: build` component に移管予定。 詳細 RFC 0001。
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

### `publish` (= namespace への出力) {#publish-namespace}

`publish` は **この component が外部に出す namespace path** の list です。 他
component / 他 Installation はその path を `listen` することで material (=
接続情報 / 環境変数原料) を受け取れます。

```yaml
components:
  db:
    kind: postgres
    publish:
      - com.example.notes.db # 任意 path
      - com.example.notes.primary # 同じ material を複数 path で公開してもよい
```

各 path に publish される material は、 その component の kind の JSON-LD
document が `publishes[]` で宣言します。 例えば `kind: postgres` の JSON-LD は
`{ host, port, database, username, passwordSecretRef, connectionString }` を
material として宣言します。

**Auto-namespacing**: `publish` を省略すると、 kernel が
`<app-id>.<component-name>` (= `com.example.notes.db`) を自動的に publish 経路と
して採用します。 同じ Installation 内の sibling component を listen するときに
便利です。

### `listen` (= namespace からの入力) {#listen-namespace}

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
        as: target # custom-domain 用 (= 別 component から書く例)
```

各 entry の option:

| option   | 用途                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| `as`     | listen shape (= `env` / `target` / `mount` 等、 kind JSON-LD が許容形を決定) |
| `prefix` | `as: env` の際に各 material field を `${PREFIX}_*` env var に展開            |
| `mount`  | kind 固有 mount point name (= custom-domain の `target` 等の意味的 anchor)   |

各 kind がどの listen shape を受理するかは、 その kind JSON-LD の `listens`
block を参照してください。

#### Auto-namespacing と sibling listen {#auto-namespacing-and-sibling-listen}

`listen` 側でも、 同じ Installation 内の sibling component は
`<app-id>.<component>` を書く代わりに短い alias を書けます (将来 release で
実装予定の syntactic sugar)。 現状の正式 syntax は full path です。

#### Cycle の検出 {#cycle-detection}

`publish` → `listen` で作られる依存 DAG が cycle を含むと、 Installation 作成
時に `invalid_argument` (400) として reject されます。

### kind 固有 field (= `spec` block) {#kind-spec-block}

各 kind の `spec` field 配下に書ける構造は、 対応する JSON-LD document の `spec`
(= JSON Schema 2020-12) に従います。 抜粋:

| kind            | 主な `spec` field                                                      |
| --------------- | ---------------------------------------------------------------------- |
| `worker`        | `routes`, `compatibilityDate`, `compatibilityFlags`, `env`, `artifact` |
| `postgres`      | `version`, `size`, `storage`, `backups`, `extensions`                  |
| `object-store`  | `name`, `public`, `versioning`, `region`, `lifecycle`                  |
| `custom-domain` | `name`, `certificate`, `redirects`                                     |

詳細は [Kind Catalog](./kind-catalog.md#component-kinds)。

## launch / health / mcp endpoints, permission requests (実装層) {#launch-health-mcp-endpoints-permission-requests}

Wave J Component contract minimization で AppSpec から **`interfaces:` /
`permissions:` top-level field を物理削除** しました。 これらは kernel が
処理しない (= "kernel は routes を知らない" 同じ原則)、 「底は自由」 な
materializer 層 / consumer 層の責務です。

実装上の表現方法 (= operator / kind 著者の任意選択):

- (option A) kind の open `spec:` field で表現。 例えば worker kind の
  materializer が `spec.routes` / `spec.launchPath` / `spec.permissions` を
  読んで実体化する。
- (option B) 別 component / 別 kind を立てて namespace pub/sub で受け渡す。
  例えば `kind: takos-store-listing` という consumer-defined kind を立てて Takos
  product 側 (= store / launcher) が `listen:` する。
- (option C) operator / consumer 層が AppSpec 外で management する (= 例:
  Takosumi Accounts が capability grant を別 UI で管理)。

旧 `interfaces.launch` / `interfaces.mcp` / `interfaces.health` /
`permissions.requested` に依存していた tooling は、 移行先の kind / namespace
shape を consumer / operator 側で定義してください。

## 「plugin」 は spec 用語ではない

AppSpec には **`plugin:` field は存在しません**。 旧 design では provider plugin
URI を AppSpec に書く案がありましたが、 廃止しました。 plugin (= materializer
実装) は operator が `createPaaSApp({ materializers: [...] })` で渡す **実装層**
であり、 manifest は **抽象 type (= kind)** のみを宣言します。 同じ kind URI
に対して複数 materializer 実装が存在しうるため、 manifest 側で
特定実装を指定することは spec の責務外です。

## ソース取得 {#source}

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

| 旧概念                                                                                    | 新位置                                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.takosumi/app.yml` + `.takosumi/manifest.yml`                                            | `.takosumi.yml` 1 file に統合                                           |
| `.takosumi/workflows/*`                                                                   | 廃止 (workflow は manifest に内包しない)                                |
| authoring/runtime 中間 manifest                                                           | 廃止 (実行結果は Deployment に記録)                                     |
| `retired authoring extension`, `TAKOSUMI_ARTIFACT`                                        | 廃止 (component.build の最小 recipe で十分)                             |
| `${ref:...}` / `${secret-ref:...}` interpolation                                          | `publish` / `listen` に置換                                             |
| `${bindings.*}` / `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` | `publish` / `listen` に統合                                             |
| `use:` edge                                                                               | `publish` / `listen` に統合 (= 唯一の edge)                             |
| `kind: oidc`                                                                              | takosumi-cloud が `operator.identity.oidc` を publish する model に移動 |
| `plugin:` field in manifest                                                               | 廃止 (= materializer は operator config 側)                             |
| `source.git` in manifest                                                                  | API input + Deployment record に持つ                                    |
| runtime target metadata                                                                   | internal ledger / Deployment evidence                                   |
| DeploymentPlan / DeploymentSnapshot / Preview                                             | dry-run response + Deployment record で十分                             |

## クロスリファレンス {#cross-references}

- [Kind Catalog](./kind-catalog.md#component-kinds) — 4 kind の spec / publishes
  / listens / outputs
- [Installer API](./installer-api.md) — 5 endpoint (dry-run / apply / rollback)
- [Manifest](./manifest.md#data-model) — AppSpec → Installation → Deployment の
  lifecycle

## 次に読む

- [Kind Catalog](./kind-catalog.md#component-kinds) — `worker` / `postgres` /
  `object-store` / `custom-domain` の schema / outputs
- [Installer API](./installer-api.md) — `.takosumi.yml` を kernel に POST する 5
  endpoint
- [Provider Plugins](./providers.md) — kind を 実 cloud / on-prem provider
  に解決する仕組み
- [Extending Takosumi](../extending.md) — 自前 kind / provider を追加する手順
- [Quickstart](../getting-started/quickstart.md) — `.takosumi.yml` を書いて
  first deploy まで
