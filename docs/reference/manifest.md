# Manifest {#manifest}

> このページでわかること: AppSpec manifest (= `.takosumi.yml`) の spec /
> validation / expand semantics / data model。

## スペック {#spec}

Takosumi の manifest は **`.takosumi.yml`** (= AppSpec) という 1 ファイルです。
仕様の正本は次の 2 ページにあります。

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — envelope / components / publish /
  listen / build recipe の全 field 仕様
- [Kind Catalog](./kind-catalog.md#component-kinds) — curated 4 種の component
  kind schema (`worker` / `postgres` / `object-store` / `custom-domain`) +
  operator-defined kind の extension ルール (= `oidc` kind は takosumi-cloud
  に移動)

API surface は [Installer API](./installer-api.md) の 5 endpoint に閉じます。

## バリデーションルール {#validation-rules}

`.takosumi.yml` (= AppSpec) は side-effect free に validate されます。 dry-run /
apply / rollback の前段に同一論理を走らせ、 同じ入力に同じ結果を返します。 WAL
書込も provider 呼出も伴いません。

仕様の正本: [AppSpec](./app-spec.md) /
[Kind Catalog](./kind-catalog.md#component-kinds) /
[Installer API](./installer-api.md)。

### Validation フェーズ順序 {#validation-phase-order}

5 phase fail-fast。 前 phase で reject なら後段は走りません。

| 順 | Phase                       | 入力                                   | 失敗時の `code`                             |
| -- | --------------------------- | -------------------------------------- | ------------------------------------------- |
| 1  | Syntax                      | `.takosumi.yml` bytes (YAML)           | `invalid_argument`                          |
| 2  | Schema                      | parsed AppSpec                         | `invalid_argument`                          |
| 3  | Publish / Listen resolution | parsed AppSpec + components scope      | `invalid_argument`                          |
| 4  | Kind catalog binding        | parsed AppSpec + materializer registry | `not_found` / `failed_precondition`         |
| 5  | Space context               | parsed AppSpec + auth-resolved Space   | `permission_denied` / `failed_precondition` |

各 step 合否は `details.validationPhase` に記録。

### Step 1 — シンタックス {#step-1-syntax}

YAML parser layer。

- 文法不正 / unterminated string / invalid escape / duplicate map key は
  `invalid_argument` で reject
- BOM / trailing garbage / 0 byte は reject

### Step 2 — スキーマ (closed vocabulary) {#step-2-schema-closed-vocabulary}

closed vocabulary。 列挙以外の top-level / nested key を含む AppSpec は reject
(warning 降格なし)。

Top-level closed key:

```text
apiVersion | kind | metadata | components
```

`apiVersion` は `"takosumi.dev/v1"` 固定、 `kind` は `"App"` 固定。

各 component の closed key (kind ごとに validate):

```text
kind | build | spec | publish | listen | name
```

Schema phase が reject する条件:

| 条件                           | 動作                      |
| ------------------------------ | ------------------------- |
| 未知 field                     | reject (warning にしない) |
| 必須 field 欠落                | reject                    |
| `kind` の URI / alias が未解決 | reject                    |
| 型違反                         | reject                    |
| closed enum 範囲外             | reject                    |

### Step 3 — Publish / Listen resolution {#step-3-publish-listen-resolution}

`publish` / `listen` edge の static check。

| 条件                                                                                  | code               |
| ------------------------------------------------------------------------------------- | ------------------ |
| `listen: <path>` の対象 namespace path が同 AppSpec の publish にない                 | `invalid_argument` |
| `listen.<path>.mount` が target kind の reserved mount に一致しない                   | `invalid_argument` |
| Cycle detected (`web` が listen するパスを publish する component が `web` を listen) | `invalid_argument` |
| `listen.<path>.prefix` / `as: env` の env var prefix が無効                           | `invalid_argument` |

Cycle detection は component を node、 publish → listen を edge とする graph に
DFS。 発見 cycle は `details.cycle: ["web", "db", "web"]` に全 node。 operator
plane が publish する path (= `operator.identity.oidc` 等) は外部 edge として
扱い、 cycle 計算には含めない。

### Step 4 — Kind catalog binding {#step-4-kind-catalog-binding}

各 component の `kind` URI (= short alias を full URI に正規化したもの) に
対する materializer が registry に登録されていることを検証。

| 条件                                                                                | code                  |
| ----------------------------------------------------------------------------------- | --------------------- |
| `kind: <URI>` に対する materializer が registry に存在しない                        | `not_found`           |
| 解決された materializer が当該 kind の spec を validate に通せない                  | `invalid_argument`    |
| 解決された materializer が `listen` で要求された target kind の material を返さない | `failed_precondition` |

materializer は operator が `createPaaSApp({ plugins: [...] })` または
`createPaaSApp({ materializers: [...] })` で bind します。 詳細:
[Architecture: Kernel](./architecture/kernel.md)。

### Step 5 — Space context {#step-5-space-context}

auth credential から resolve された Space に AppSpec が admissible か判定。

| 条件                                                           | code                            |
| -------------------------------------------------------------- | ------------------------------- |
| AppSpec が要求する `kind` を Space が許可していない            | `permission_denied`             |
| `metadata.id` が Space の name policy に違反                   | `permission_denied`             |
| Quota 超過 (component count / artifact size / activation slot) | `resource_exhausted` (HTTP 413) |

`failed_precondition` は HTTP **409** に、 `resource_exhausted` は HTTP **413**
に mapping されます。

### Validation エラーエンベロープ {#validation-error-envelope}

```json
{
  "code": "invalid_argument",
  "message": "components.web.kind is not a known kind",
  "requestId": "req:01J...",
  "details": {
    "validationPhase": "schema",
    "validationPath": "$.components.web.kind",
    "spaceId": "space:default",
    "manifestDigest": "sha256:..."
  }
}
```

複数 reject 候補が同時成立しても、 validation は最初に firing した phase の
最初の error のみを返します (deterministic 保持のため)。 client は fix→retry
loop で残りを発見します。

### スキーマバージョニング {#schema-versioning}

`apiVersion` は AppSpec envelope 全体の wire schema 番号。

| 値                  | 意味                            |
| ------------------- | ------------------------------- |
| `"takosumi.dev/v1"` | v1 で kernel が受理する唯一の値 |

breaking change は `"takosumi.dev/v2"` 等で発行し kernel が version ごとに
routing。

### 冪等性 {#idempotence}

同一 AppSpec bytes に対する validation は phase / path / message が完全一致
します。 CI 上 dry-run と production kernel の検証の等価性を担保します。

## Expand セマンティクス {#expand-semantics}

current AppSpec の component dependency / binding semantics。 component
間の接続は **`publish` / `listen` edge のみ** で表現する。 旧 `use:` edge /
`${ref:...}` placeholder 文法は current public AppSpec には存在しない。

### ソース形式 {#source-form}

AppSpec は `.takosumi.yml` の `components` map だけを public dependency source
として扱う。 component 間の依存は **`publish` (= 自分が出す material) と
`listen` (= 他 component の material を受け取る)** の 2 つの edge で明示する。

```yaml
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
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    listen:
      com.example.notes.db:
        as: env
        prefix: DATABASE_
      com.example.notes.assets:
        as: env
        prefix: ASSETS_
```

#### `publish` {#publish}

`publish` value は namespace registry に登録する path の **配列** で、 component
が apply 後に返す `outputs` (= kind JSON-LD の `publishes[]` で宣言された
material) がその path に publish される。 同 AppSpec 内の他 component から
listen することも、 cross-installation で operator account plane (= Takosumi
Accounts) から listen することも、 同じ path 表現で扱える。

#### `listen` {#listen}

`listen` の key は publish 側の namespace path。 value は consumer 側の binding
rule で、 current v1 は次を持つ:

| Field    | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `as`     | `env` / `mount` / `target` のいずれか (= projection 形式)             |
| `prefix` | `as: env` のとき、 env 名を `${PREFIX}<FIELD>` に変換する文字列       |
| `mount`  | reserved mount point identifier (= kind 側で reserve した short name) |

`as: env` は producer の outputs map を `${PREFIX}<FIELD>` env vars として
注入する。 `as: target` は upstream worker の URL を custom-domain の target
として使う形 (= ingress projection)。

### バリデーション {#validation}

installer / kernel は AppSpec parse 時に publish / listen graph を作る。

- `listen` の path は **同じ AppSpec の `publish` にあるか、 operator plane の
  reserved path** に一致しなければならない。
- self-reference (= 同 component の publish path を listen) は禁止。
- cycle は禁止 (= component を node、 publish → listen を edge とする DAG)。
- `listen.<path>.mount` は kind の reserved mount short name にのみ使える。
- 旧 `use:` edge / `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` /
  `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` は
  current AppSpec では invalid syntax (= parser が reject)。

validation error は apply 前に surface し、 resource は materialize されない。

### 適用順序 {#apply-order}

apply pipeline は publish / listen graph から topological order を決める。 独立
component は並行実行できるが、 listen 側 component は publish 側 outputs が
確定した後に materialize される。

provider output は raw string interpolation ではなく、 listen binding rule に
従って runtime desired state に注入される。 secret raw value は AppSpec に
戻さない。 provider が secret を出す場合は secret-store boundary を通した
reference (= `secret://...`) として扱い、 worker runtime 側で adapter が
解決する。

### Cross-space / operator plane {#cross-space-operator-plane}

current AppSpec の listen path は同 AppSpec の publish path に閉じる必要はなく、
**operator account plane が publish する reserved path** (=
`operator.identity.oidc` 等) も listen できる。 例えば Takosumi Accounts
(takosumi-cloud) が `operator.identity.oidc` namespace path に OIDC client
material を publish し、 worker は `listen.operator.identity.oidc` で
`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` /
`OIDC_REDIRECT_URIS` を受け取る。

Space 間共有は AppSpec placeholder ではなく、 Namespace Export / Binding
contract の責務。

## データモデル {#data-model}

AppSpec (= `.takosumi.yml`) のデータモデルと component graph の構造、 AppSpec →
Installation → Deployment の lifecycle。

AppSpec は closed な install surface である。 desired な portable component を
宣言するもので、 canonical state ではない。 Space、 actor、 catalog release、
policy、 quota、 credential、 approval、 journal state、 observation は AppSpec
ではなく install context から供給される。

Public v1 は `POST /v1/installations` 系 5 endpoint と `takosumi install` CLI が
実装する **Component + Kind** AppSpec モデルである。 authoring shorthand や
runtime 中間形式は存在せず、 kernel が読むのは `.takosumi.yml` そのものである。

### 許可される public フィールド {#allowed-public-fields}

Root fields:

```text
apiVersion
kind
metadata
components
```

`apiVersion` は必須で `"takosumi.dev/v1"` に固定。 `kind` は必須で `"App"` に
固定。 未知の top-level field は schema validation で失敗する (= warning
ではない)。 Wave J で `interfaces` / `permissions` top-level field は物理削除 済
(= top-level field として宣言できない)。

`metadata` fields:

```text
id
name
description
publisher
homepage
```

`components` の各 entry fields:

```text
kind | spec | build | publish | listen
```

`kind` は **短い alias** (= `worker`) または **完全な JSON-LD URI** (=
`https://takosumi.com/kinds/v1/worker`) の文字列。 alias は対応 JSON-LD の
`aliases[]` に登録された名前のみ受理し、 parse 段階で full URI に正規化する。

`build` は AppSpec が許可する **唯一の build 概念** で、 `{ command, output }`
の最小 recipe のみ表現できる。 jobs / steps / matrix / triggers / pipeline は
持たない (= CI workflow ではない)。

`publish` / `listen` は component 間接続の **唯一の表現** である。 `use:` edge
と文字列 interpolation (`${ref:...}` / `${secret-ref:...}` / `${bindings.*}` 等)
は v1 AppSpec では廃止された。

### Space コンテキスト {#space-context}

`Space` は AppSpec の外にある。 同じ AppSpec が異なる Space で異なる resolve
結果になることがある。 namespace path、 catalog release 選択、 policy、 secret、
artifact、 approval、 journal、 observation は Space scope である。

```text
appspec + space:acme-prod -> production catalog / policy / quotas
appspec + space:acme-dev  -> development catalog / policy / quotas
```

public AppSpec は `space` / `tenant` / `org` / credential / namespace registry
の構成 field を含んではならない。 これらは Installation context / operator 設定
であり、 authoring intent ではない。

### Component 一覧 {#components}

各 `components` entry は 1 つの portable Component を宣言する。

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.notes.db

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
```

> Note: `spec.routes` は worker materializer の慣習 field で、 worker kind
> contract には declare されません (= 「底は自由」 原則。 詳細は
> [AppSpec § launch / health / mcp endpoints, permission requests](./app-spec.md#launch-health-mcp-endpoints-permission-requests)
> 参照)。 別 materializer 実装は routes を別表現で扱っても構いません。

`kind` が semantic contract。 短 alias または完全 URI のいずれでもよい。
**materializer (= 実装層)** は operator 側
`createPaaSApp({ materializers: [...] })` config で渡され、 manifest
には現れない。 同じ kind URI に複数の materializer 実装が存在しうる (=
Cloudflare 実装 / AWS Fargate 実装等)、 operator が 1 つを 選ぶ。 provider 選択
/ 配置 / placement は AppSpec ではなく operator policy / Space context
が決める。

各 component の output (= apply 後の値) は kernel が persist し、 publish 宣言
された namespace path に material として register される。

### Namespace Pub/Sub グラフ {#namespace-pub-sub-graph}

`publish` / `listen` は component を node、 namespace path を edge label と する
DAG を作る。

```text
db ─publish─> com.example.notes.db ─listen──> web
media ─publish─> com.example.notes.media ─listen──> web
operator.identity.oidc ─(takosumi-cloud publish)──> web (listen)
```

kernel は publish → listen 解決時に cycle を reject し、 topological order で
materializer apply を実行する。 cycle 検出は graph DFS。

各 listen entry の semantics:

| sub-key  | 解決                                                               |
| -------- | ------------------------------------------------------------------ |
| `as`     | listen shape (= `env` / `target` / `mount` 等、 kind JSON-LD 規定) |
| `prefix` | `as: env` で各 material field を `${PREFIX}_*` env var に展開      |
| `mount`  | kind 固有 anchor name (= 意味的 mount point)                       |

**Auto-namespacing**: component が `publish` を省略すると、 kernel が
`<app-id>.<component-name>` を自動 publish する。 sibling component の参照は
この path を `listen` するだけで完結する。

### Installation lifecycle {#installation-lifecycle}

AppSpec は唯一の入力。 そこから kernel が次の 3 段階を実行する。

```text
AppSpec (.takosumi.yml)
   ↓ POST /v1/installations
Installation (account + space + appId + currentDeployment + status)
   ↓ POST /v1/installations/{id}/deployments
Deployment (source.commit + manifestDigest + outputs + status + timestamps)
```

`Installation` は 1 つの Space に対して 1 つの App が入っている状態を表す。 所有
/ 課金 / 権限 / 現在状態の単位。

`Deployment` は 1 回の apply 結果。 source.commit、 manifestDigest、 component
ごとの build artifact、 materializer が作った resource id を記録する。 履歴 /
audit / rollback の単位。

### Materializer 解決 {#materializer-resolution}

各 component の `kind` は **materializer** (= 実装層) が解決する。 materializer
は kind URI の registry に登録され、 operator が任意の形態 (= plugin object /
inline function / 別 package import) で提供する。 manifest 側からは特定 impl
を指定しない。

Materializer responsibilities:

- `kind` 固有の input spec を validate
- target runtime (Cloudflare Workers / Kubernetes / AWS Fargate 等) に 対する
  provision を生成
- apply 後の output fields (`url` / `connectionString` / `bucket` 等) を返す
- kind JSON-LD が宣言した `publishes[]` material を namespace registry に
  register する

詳細:
[Provider Plugins — Resolution Algorithm](./providers.md#resolution-algorithm)。

### 削除された旧概念 {#removed-old-concepts}

| 旧概念                               | 新位置                                   |
| ------------------------------------ | ---------------------------------------- |
| `.takosumi/app.yml` + `manifest.yml` | `.takosumi.yml` 1 file に統合            |
| `.takosumi/workflows/*`              | 廃止                                     |
| authoring/runtime 中間 manifest      | 単一 AppSpec モデル、 compile step なし  |
| retired authoring extension          | `component.build` の最小 recipe          |
| `${ref:...}` / `${secret-ref:...}`   | `publish` / `listen`                     |
| `${bindings.*}` / `${secrets.*}`     | `publish` / `listen`                     |
| `use:` edge                          | `publish` / `listen` に統合              |
| `kind: oidc`                         | takosumi-cloud の OIDC namespace publish |
| `plugin:` in manifest                | materializer は operator config 側       |
| Plan / Snapshot / Preview entity     | dry-run response (entity 化されない)     |
| DeploymentPlan / DeploymentSnapshot  | Deployment record の outputs に統合      |

## 次に読む {#next-steps}

- [AppSpec](./app-spec.md) — `.takosumi.yml` envelope の正本
- [Kind Catalog](./kind-catalog.md#component-kinds) — 4 kind の spec / outputs /
  publish / listen 仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の 5 endpoint
- [Provider Plugins — Resolution Algorithm](./providers.md#resolution-algorithm)
  — kind から concrete provider への resolution
- [Architecture: Kernel](./architecture/kernel.md) — installer pipeline の責務
  境界

## クロスリファレンス {#cross-references}

- [Kernel HTTP API](./kernel-http-api.md)
- [Namespace Exports](./namespace-exports.md)
- [OperationPlan / WAL](./architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal)
- [Closed Enums](./closed-enums.md)
