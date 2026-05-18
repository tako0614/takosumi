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

各 component は `kind` を 1 つ持ち、 catalog に登録された 5 kind
のいずれかです。 詳細 schema は
[Component Kind Catalog](./component-kind-catalog.md) 参照。

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - /
    use:
      db:
        env: DATABASE_URL
      media:
        envPrefix: BLOB_
      auth:
        mount: oidc

  db:
    kind: postgres

  media:
    kind: object-store

  auth:
    kind: oidc
    redirectPaths:
      - /api/auth/callback
    scopes: [openid, profile, email]
```

### Component common fields

| field        | required | 説明                                                                                       |
| ------------ | -------- | ------------------------------------------------------------------------------------------ |
| `kind`       | yes      | catalog 5 種のいずれか (`worker` / `postgres` / `object-store` / `oidc` / `custom-domain`) |
| `build`      | no       | 最小 build recipe (= artifact を得る条件、 CI workflow ではない)                           |
| `use`        | no       | 他 component への依存 edge (= 旧 interpolation の代替)                                     |
| 各 kind 固有 | varies   | catalog 定義 (`routes` / `scopes` / `redirectPaths` 等)                                    |

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

build を持たない component (= `kind: postgres` / `object-store` / `oidc` /
`custom-domain`) は provider が直接 materialize します。

### `use` (= component 間 edge)

依存先 component を **構造的に宣言** します。 文字列 interpolation
は使いません。

```yaml
components:
  web:
    kind: worker
    use:
      db:
        env: DATABASE_URL
      media:
        envPrefix: BLOB_
      auth:
        mount: oidc
```

各 edge の sub-key:

| sub-key     | 用途                                                   |
| ----------- | ------------------------------------------------------ |
| `env`       | 依存先 connection string 等を単一 env var に注入       |
| `envPrefix` | 依存先の全 output field を `${PREFIX}_*` で env に展開 |
| `mount`     | OIDC consumer 等の reserved mount point に bind        |

Takosumi は `use` edge から secret 性 / 依存関係 / 削除順序 / 権限を安全に
解決します。 cycle は reject、 topological order で provider apply。

### `kind` ごとの追加 field

詳細は [Component Kind Catalog](./component-kind-catalog.md)。 抜粋:

| kind            | 主な field                                      |
| --------------- | ----------------------------------------------- |
| `worker`        | `build`, `use`, `routes`                        |
| `postgres`      | `spec.class` (= `standard` / `small` / `large`) |
| `object-store`  | (なし、 generated bucket)                       |
| `oidc`          | `redirectPaths`, `scopes`                       |
| `custom-domain` | `name`, `target` (= 他 component への `use`)    |

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

| 旧概念                                                                                    | 新位置                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `.takosumi/app.yml` + `.takosumi/manifest.yml`                                            | `.takosumi.yml` 1 file に統合               |
| `.takosumi/workflows/*`                                                                   | 廃止 (workflow は manifest に内包しない)    |
| authoring/runtime 中間 manifest                                                           | 廃止 (実行結果は Deployment に記録)         |
| `retired authoring extension`, `TAKOSUMI_ARTIFACT`                                        | 廃止 (component.build の最小 recipe で十分) |
| `${ref:...}` / `${secret-ref:...}` interpolation                                          | `use:` edge に置換                          |
| `${bindings.*}` / `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` | `use:` edge に統合                          |
| `source.git` in manifest                                                                  | API input + Deployment record に持つ        |
| runtime target metadata                                                                   | internal ledger / Deployment evidence       |
| DeploymentPlan / DeploymentSnapshot / Preview                                             | dry-run response + Deployment record で十分 |

## Cross-references

- [Component Kind Catalog](./component-kind-catalog.md) — 5 kind の schema
- [Installer API](./installer-api.md) — 5 endpoint (dry-run / apply / rollback)
- [Architecture: Manifest model](./architecture/manifest-model.md) — AppSpec →
  Installation → Deployment の lifecycle
