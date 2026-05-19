# Kind Catalog {#kind-catalog}

> このページでわかること: Takosumi の component kind / JSON-LD source-of-truth /
> artifact kind の正本。 curated 4 種 + operator-defined kind の参照先、 各 kind
> の spec / publishes / listens / outputs、 JSON-LD で kind を publish
> する手順、 artifact (= DataAsset) kind registry の仕様。

## 概要 {#overview}

v1 manifest (= `.takosumi.yml`) では各 component が `kind` を持ち、 catalog
に登録された curated 4 種のいずれか、 または operator が自前 `.jsonld` で
publish した URI を指します。 仕様は本ページの section に集約されています:

- [Component Kinds](#component-kinds) — curated 4 kind の spec / outputs /
  publish / listen 仕様
- [JSON-LD Source-of-truth](#json-ld-source-of-truth) — kind を JSON-LD で
  publish する仕組みと operator-defined kind の publish 手順
- [Artifact Kinds](#artifact-kinds) — DataAsset kind registry / connector
  enforcement / upload flow

関連 docs:

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — `.takosumi.yml` 全体仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の 5 endpoint

## Component Kinds {#component-kinds}

> `.takosumi.yml` の `components[*].kind` で使える 4 kind の spec / publishes /
> listens / outputs。 各 kind の JSON-LD document が **これら 4 項目を一体宣言**
> します。

Takosumi catalog の 4 built-in kind は `spec/contexts/kinds/v1/<name>.jsonld` が
canonical source です。 各 .jsonld は次を 1 つの document で宣言します:

1. **`spec`** (= JSON Schema 2020-12) — AppSpec の `components.<name>.spec`
   に書ける構造。
2. **`publishes`** (= array) — この kind が namespace registry に publish する
   material と target namespace path。
3. **`listens`** (= object) — この kind が listen 可能な namespace path と、
   受信した material をどう注入するか (`shape` / `envMap`)。
4. **`outputs`** (= array) — apply 後に provider が返す値の reserved 名前 +
   meaning。

新 kind の追加は JSON-LD document を任意 domain で publish し、 materializer
実装 (= 形式任意) を operator が `createPaaSApp({ materializers: [...] })` に
渡せば成立します。 catalog は 4 種「frozen」 ではなく、 任意の operator が
拡張可能です。

| `kind` (alias)  | URI                                           | 用途                                           |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`        | Serverless HTTP service (= JS bundle artifact) |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`      | Managed PostgreSQL                             |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store`  | S3-compatible bucket                           |
| `custom-domain` | `https://takosumi.com/kinds/v1/custom-domain` | Public domain + TLS termination                |

### `oidc` kind は takosumi-cloud に移動 {#oidc-kind-moved-to-takosumi-cloud}

旧 `kind: oidc` は takosumi core の責務外として削除しました。 takosumi-cloud (=
Takosumi Accounts operator distribution) が `operator.identity.oidc` namespace
path に OIDC client material を publish します。 worker は
`listen.operator.identity.oidc` で標準 env (`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID`
/ `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS`) を受け取ります。

詳細は takosumi-cloud の対応 docs (= 同 repo
`spec/contexts/kinds/v1/oidc.jsonld` 予定) を参照してください。 takosumi kernel
は OIDC client を発行しません。

### `outputs` の予約名前 {#outputs-reserved-names}

全 kind 横断で次の output field 名は reserved meaning を持ち、 consumer は
provider 差分に関係なく安定 semantics に依存できます。

| name       | 意味                                         |
| ---------- | -------------------------------------------- |
| `url`      | scheme-bearing public URL (`https://...`)    |
| `endpoint` | service / API endpoint URL                   |
| `id`       | provider-scope identifier                    |
| `version`  | provider-scope version / revision identifier |

これらの名前を持つ新規 output 追加は kind JSON-LD の改訂を要します。

### Worker {#worker}

Serverless HTTP service。 JS bundle (`build.output`) を artifact
として動きます。

#### スペック

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      compatibilityDate: "2026-01-01"
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
      operator.identity.oidc:
        as: env
```

| field                    | required                  | 説明                                           |
| ------------------------ | ------------------------- | ---------------------------------------------- |
| `build`                  | yes                       | `{ command, output }` (= artifact 生成 recipe) |
| `spec.compatibilityDate` | yes (for direct artifact) | Cloudflare 互換 date                           |
| `listen`                 | no                        | listen 対象 namespace path                     |

> Wave J で worker.jsonld から `routes` 宣言を削除しました。 worker materializer
> (= `@takos/takosumi-cloudflare-providers` 等の shape provider) は
> `spec.routes` (string array) を実装慣習として読みますが、 worker kind contract
> には宣言されません (= 「底は自由」 原則)。 別の materializer 実装は routes
> を別の表現 (= 別 kind の namespace pub 等) で扱っても構いません。

#### Publishes 一覧

`worker` は **`<app-id>.<component-name>`** namespace path に下記 material を
publish します:

```text
{ url, id }
```

#### Listens 一覧

`worker` は任意の sibling namespace path を `as: env` で listen し、 受信した
material を `${PREFIX}_*` env var として注入します (`prefix` option で PREFIX
を選択)。 詳細な envMap は AppSpec listen options が決定します。

#### Outputs 一覧

| field     | 意味                             |
| --------- | -------------------------------- |
| `url`     | 割り当てられた public URL        |
| `id`      | provider-scope worker identifier |
| `version` | 現在 deploy 中の bundle version  |

#### Capabilities {#capabilities}

`scale-to-zero`, `always-on`, `websocket`, `long-request`, `sticky-session`,
`private-networking`, `geo-routing`, `crons`。

### Postgres {#postgres}

Managed PostgreSQL instance。

#### スペック

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
      backups:
        enabled: true
        retentionDays: 7
    publish:
      - com.example.notes.db
```

| field             | required | 説明                                         |
| ----------------- | -------- | -------------------------------------------- |
| `spec.version`    | yes      | PostgreSQL major version (= `15` / `16`)     |
| `spec.size`       | yes      | `small` / `medium` / `large` / `xlarge`      |
| `spec.storage`    | no       | `{ sizeGiB, type }`                          |
| `spec.backups`    | no       | `{ enabled, retentionDays }`                 |
| `spec.extensions` | no       | enable する extension list (= `pgvector` 等) |

#### Publishes 一覧

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ host, port, database, username, passwordSecretRef, connectionString }
```

#### Listens 一覧

`postgres` は listen を持ちません (= 空 `{}`)。

#### Outputs 一覧

| field               | 意味                                    |
| ------------------- | --------------------------------------- |
| `host`              | hostname                                |
| `port`              | port number (typically 5432)            |
| `database`          | database name                           |
| `username`          | role name                               |
| `passwordSecretRef` | secret store reference (= secret)       |
| `connectionString`  | client が使う connection URL (= secret) |

#### 接続例 (listen 側)

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
        # → DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME /
        #    DB_PASSWORDSECRETREF / DB_CONNECTIONSTRING を env に注入
```

### Object-Store {#object-store}

S3-compatible bucket。

#### スペック

```yaml
components:
  media:
    kind: object-store
    spec:
      name: notes-media
      versioning: true
    publish:
      - com.example.notes.media
```

| field             | required | 説明                                    |
| ----------------- | -------- | --------------------------------------- |
| `spec.name`       | yes      | logical bucket name                     |
| `spec.public`     | no       | anonymous read 許可                     |
| `spec.versioning` | no       | versioning enable                       |
| `spec.region`     | no       | provider region                         |
| `spec.lifecycle`  | no       | `{ expireAfterDays, archiveAfterDays }` |

#### Publishes 一覧

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ bucket, endpoint, region, accessKeyRef, secretKeyRef }
```

#### Listens 一覧

`object-store` は listen を持ちません (= 空 `{}`)。

#### Outputs 一覧

| field          | 意味                                        |
| -------------- | ------------------------------------------- |
| `bucket`       | bucket name                                 |
| `endpoint`     | S3 endpoint URL                             |
| `region`       | bucket region                               |
| `accessKeyRef` | access key id 用 secret store reference     |
| `secretKeyRef` | secret access key 用 secret store reference |

#### 接続例 (listen 側)

```yaml
components:
  web:
    kind: worker
    listen:
      com.example.notes.media:
        as: env
        prefix: BLOB_
        # → BLOB_BUCKET / BLOB_ENDPOINT / BLOB_REGION /
        #    BLOB_ACCESSKEYREF / BLOB_SECRETKEYREF
```

### Custom-Domain {#custom-domain}

DNS record + public domain TLS termination。

#### スペック

```yaml
components:
  domain:
    kind: custom-domain
    spec:
      name: notes.example.com
      certificate:
        kind: auto
    listen:
      com.example.notes.web:
        as: target
```

| field              | required | 説明                                              |
| ------------------ | -------- | ------------------------------------------------- |
| `spec.name`        | yes      | FQDN (e.g. `notes.example.com`)                   |
| `spec.certificate` | no       | `{ kind: auto / managed / provided, secretRef? }` |
| `spec.redirects`   | no       | HTTP redirect rule list                           |
| `listen.<worker>`  | yes      | `as: target` で upstream worker namespace         |

#### Publishes 一覧

`<app-id>.<component-name>` namespace path に下記 material を publish:

```text
{ fqdn, certificateId }
```

#### Listens 一覧

`custom-domain` は任意の sibling worker namespace を `as: target` で listen し、
publish material の `url` を upstream として使用します。

#### Outputs 一覧

| field           | 意味                              |
| --------------- | --------------------------------- |
| `fqdn`          | resolved FQDN                     |
| `certificateId` | provider-scope TLS certificate id |
| `nameservers`   | (optional) DNS nameserver list    |

## JSON-LD Source-of-truth {#json-ld-source-of-truth}

> `components[*].kind` で参照される **component kind** を JSON-LD で公開する
> 正本の仕様。 operator が自前 kind を publish する手順もここに記載されます。

Takosumi は curated 4 種の built-in component kind (`worker` / `postgres` /
`object-store` / `custom-domain`) を持ちます (= `oidc` kind は takosumi-cloud の
`operator.identity.oidc` namespace pub に移動)。 これらの kind は **JSON-LD
文書として公開** され、 `@id` (= 完全 URI) で一意に識別されます。

catalog は frozen ではなく、 operator は自前 domain で同じ shape の `.jsonld` を
publish するだけで新 kind を追加できます。 これが Takosumi が掲げる
「ソフトウェアの民主化」 の土台です (= 第三者は kernel に手を入れずに自分の
vocabulary を立ち上げられる)。

### URL 規約 {#url-convention}

```
https://takosumi.com/contexts/v1.jsonld                  ← root vocabulary
https://takosumi.com/contexts/kinds/v1/<name>.jsonld     ← 各 kind 文書
```

operator が自前 kind を立てるときも同じ形を採用してください:

```
https://operator.example.com/contexts/v1.jsonld          ← operator が root を引く場合
https://operator.example.com/kinds/lambda                ← @id (= identifier)
```

operator は Takosumi の root context (`takosumi.com/contexts/v1.jsonld`) を
そのまま `@context` 値として参照しても、 独自 root を publish しても良いです。
kernel は `@context` の意味処理 (= semantic expand) を行わず、 **URI を
identifier として** だけ扱います。

### 文書 shape {#document-shape}

各 kind 文書は次のフィールドを含みます。

| フィールド     | 必須 | 意味                                                                 |
| -------------- | ---- | -------------------------------------------------------------------- |
| `@context`     | yes  | root vocabulary URL (= `https://takosumi.com/contexts/v1.jsonld` 等) |
| `@id`          | yes  | この kind の canonical URI (= `https://.../kinds/v1/<name>`)         |
| `@type`        | yes  | 固定 `"ComponentKind"`                                               |
| `name`         | yes  | short name (= AppSpec の `kind` 短縮形に対応; 例 `worker`)           |
| `version`      | yes  | `v1` / `v2` 等の kind version                                        |
| `description`  | yes  | 1 文の説明                                                           |
| `spec`         | yes  | 入力 schema の field list (= `[{ name, type, required, meaning }]`)  |
| `outputs`      | yes  | 出力 field list                                                      |
| `capabilities` | yes  | provider が claim できる capability の固定集合                       |

`spec` / `outputs` の各 entry は次のキーを持ちます:

- `name` : field 名
- `type` : type hint (= `string` / `boolean` / `string[]` / `object` / `enum`
  等)
- `required` : 必須かどうか
- `meaning` : human-readable 意味付け
- `enum` : enum 型の場合の許容値リスト (optional)

ここに書かれた shape は **正本** であり、 `packages/contract/src/app-spec.ts` の
`COMPONENT_KINDS` 配列および `packages/plugins/src/kinds/*.ts` の TS schema
はこの正本に追従します。

### operator-defined kind の publish 手順 {#operator-defined-kind-publish}

1. **`.jsonld` を立てる** — 自分の domain で
   `https://operator.example.com/kinds/lambda` 等の URL から JSON-LD 文書を返す
   HTTPS endpoint を publish します。 shape は 上記の通り (例として
   [`spec/contexts/kinds/v1/worker.jsonld`](https://github.com/takos/takosumi/blob/main/spec/contexts/kinds/v1/worker.jsonld)
   を参考に)。
2. **plugin で attach** — `packages/plugins/src/kinds/<your-kind>.ts` 相当の
   実装を持つ Deno module を JSR (または npm) に publish し、 operator は
   `createPaaSApp({ plugins: [yourKindPlugin(opts), ...] })` で plain array に
   渡します (= Vite plugin pattern)。
3. **AppSpec で参照** — App author は `.takosumi.yml` で
   `kind: https://operator.example.com/kinds/lambda` のように full URI を直接
   書けば、 kernel は parser 段階で「URI 形式の kind 名」を accept します。

### kernel が context を resolve する方針 {#kernel-context-resolution-policy}

- **起動時 cache のみ** — kernel は built-in kind の `.jsonld` を embed して
  起動時に load します。 operator-defined kind は plugin 登録時に local cache
  に格納されます。
- **fetch のみ** — `@context` URL を opportunistically fetch
  することはありません。 semantic expand / RDF reasoning は行わず、 URI を
  identifier として完全一致 比較で扱います。
- **`@context` は文字列 hint** — JSON-LD parser として動作するわけではないため、
  kind 文書を fetch して読み解く必要は無く、 plugin が提供する TS schema が
  実行時 validate の正本となります。

## Artifact Kinds {#artifact-kinds}

> DataAsset の kind 一覧と各 kind の用途。

Takosumi の artifact は DataAsset を裏付ける content-addressed な bytes /
pointer レコードである。 Manifest resource が参照する `Artifact` は `kind` を
持ち、 `hash` (`POST /v1/artifacts` が返す `sha256:<hex>`) または `uri` (OCI
registry URL のような外部 pointer) のいずれかを持つ。

`Artifact.kind` は **protocol レベルでは open string** である。 同梱の kernel は
下記の kind を登録する。 `GET /v1/artifacts/kinds` や `takosumi artifact kinds`
は、 deploy された kernel と runtime-agent connector が認識する種別を operator
に見せる。 サードパーティ connector は `registerArtifactKind` で kind
を追加できる。 registry は discovery surface であって、 hard-coded された public
enum ではない。

### 同梱 Kind {#bundled-kinds}

同梱の Takosumi プラグインは次の 5 種類を登録する。

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

#### `oci-image` {#oci-image}

- 用途: OCI / Docker container image を registry URI で参照
- 典型例: `artifact: { kind: "oci-image", uri: "ghcr.io/..." }`
- Kernel storage: pointer のみ。 bytes は registry に残る

#### `js-bundle` {#js-bundle}

- 用途: Cloudflare Workers / Deno Deploy 向けの ESM JavaScript bundle
- 典型例: `artifact: { kind: "js-bundle", hash: "sha256:..." }`
- Kernel storage: content-addressed upload

#### `lambda-zip` {#lambda-zip}

- 用途: AWS Lambda の zipped function package を consume する connector 向け
- 典型例: `artifact: { kind: "lambda-zip", hash: "sha256:..." }`
- Kernel storage: content-addressed upload

#### `static-bundle` {#static-bundle}

- 用途: Pages 系 host の static site archive
- 典型例: `artifact: { kind: "static-bundle", hash: "sha256:..." }`
- Kernel storage: content-addressed upload

#### `wasm` {#wasm}

- 用途: WASM artifact を実行 / 添付する connector 向けの module bytes
- 典型例: `artifact: { kind: "wasm", hash: "sha256:..." }`
- Kernel storage: content-addressed upload

`worker` component は protocol よりも意図的に厳しく、 build output 由来の
`js-bundle` または image-backed artifact を要求する。provider request では image
input が `artifact: { kind: "oci-image", uri: image }`
と同じ意味に正規化される。 他の artifact kind は、 選ばれた connector が
`acceptedArtifactKinds` で宣言したときに限り有効である。

### Connector による強制 {#connector-enforcement}

runtime-agent connector は `acceptedArtifactKinds` ベクトルを宣言する。
runtime-agent lifecycle dispatcher は、 `spec.artifact.kind`
の値がそのベクトルに含まれない apply request を reject する。 protocol 拡張を
open に保ちつつ、 具体的な connector 境界で fail-closed する設計である。

例:

- Cloudflare Workers / Deno Deploy worker connector は `js-bundle`
  を受け入れる。
- OCI-backed の worker connector は `oci-image` を受け入れる。
- 将来の / operator がインストールする connector は `lambda-zip`、
  `static-bundle`、 `wasm`、 または登録済み独自種を受け入れうる。

### 登録 API {#registration-api}

contract パッケージは `GET /v1/artifacts/kinds` を裏付ける process global な
registry を公開する。

```ts
import {
  getArtifactKind,
  isArtifactKindRegistered,
  listArtifactKinds,
  registerArtifactKind,
  unregisterArtifactKind,
} from "takosumi-contract";

registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle for serverless runtimes",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

シグネチャ:

```ts
registerArtifactKind(
  kind: RegisteredArtifactKind,
  options?: { allowOverride?: boolean },
): RegisteredArtifactKind | undefined;

listArtifactKinds(): readonly RegisteredArtifactKind[];
getArtifactKind(kind: string): RegisteredArtifactKind | undefined;
isArtifactKindRegistered(kind: string): boolean;
unregisterArtifactKind(kind: string): boolean;
```

衝突時の挙動:

- ある `kind` の最初の登録は成功し `undefined` を返す。
- 同一メタデータでの 2 回目の登録は silent no-op。
- メタデータが異なり `allowOverride: false` の 2 回目の登録は警告を出し、 元の
  レコードを残す。
- `allowOverride: true` の 2 回目の登録はレコードを置き換え、 以前のものを返す。
  この path は operator 管理の bootstrap や plugin loader 文脈に予約される。

### サイズ上限 {#size-limits}

artifact route は `TAKOSUMI_ARTIFACT_MAX_BYTES` をグローバルに強制する。
登録済み kind が `maxSize` を持つ場合、 その per-kind 値がその kind の upload
について route default を上書きする。 未知 / 未登録の kind は global cap に
フォールバックする。

deploy route も plan / apply 副作用の前に manifest 宣言の artifact size を
強制する。 resource が `spec.artifact.size` を含むとき、 その値はバイト数として
解釈される。 登録済み kind の `maxSize` (未知 kind は global cap) を超えない
非負整数でなければならない。 これは OCI image URI のような外部 pointer に対する
provider 前の quota gate である。 `POST /v1/artifacts` 経由でアップロードされた
content は artifact upload route で再度チェックされる。

`oci-image` は通常 `uri` を使うため、 `takosumi artifact push` は不要である。
upload された各 kind は kernel object-storage アダプタ経由で
`<bucket>/artifacts/<sha256-hex>` の下に保存される。 client 側の
`expectedDigest` field の有無にかかわらず、 digest は server
側で計算・検証される。

### アップロードフロー {#upload-flow}

```text
takosumi artifact push <file> --kind <kind>
  POST /v1/artifacts (multipart: kind, body, metadata, expectedDigest?)
    -> kernel computes sha256 and enforces the global / registered size cap
    -> kernel writes bucket/artifacts/<hex> via ObjectStoragePort
    -> kernel returns { hash, kind, size, uploadedAt, metadata }

manifest.spec.artifact:
  kind: js-bundle
  hash: sha256:abc123...

kernel apply
  -> POST /v1/lifecycle/apply { spec, artifactStore: { baseUrl, token } }
  -> connector verifies acceptedArtifactKinds
  -> connector fetches bytes by hash via artifactStore
  -> connector materializes the resource and returns a handle
```

認証境界:

- 書き込み endpoint (`POST /v1/artifacts`、 `DELETE /v1/artifacts/:hash`、
  `POST /v1/artifacts/gc`) は deploy bearer を要求する。
- 読み込み endpoint (`GET /v1/artifacts/:hash`、 `HEAD /v1/artifacts/:hash`) は
  `TAKOSUMI_ARTIFACT_FETCH_TOKEN` も受け付ける。 runtime-agent は deploy bearer
  を保持せずに bytes を取得できる。

### Discovery と CLI {#discovery-and-cli}

```bash
takosumi artifact push ./worker.js --kind js-bundle --metadata entrypoint=index.js
takosumi artifact list
takosumi artifact kinds --table
takosumi artifact gc --dry-run
takosumi artifact rm sha256:abc123...
```

`takosumi artifact kinds` は呼び出し時点で kernel が公開する registry の
snapshot を反映する。 registry を変更することはない。

## クロスリファレンス {#cross-references}

- [AppSpec](./app-spec.md) — `.takosumi.yml` 全体仕様
- [Installer API](./installer-api.md) — dry-run / apply / rollback の wire spec
- [Manifest](./manifest.md#data-model) — kind と namespace registry の関係
- [Plugins extending](../extending.md) — 新 kind / provider 登録の手順
- [Connector Contract](./connector-contract.md) — operator-installed connector
  identity / accepted-kind vector
- [DataAsset Policy](./data-asset-policy.md) — DataAsset class policy
- [Closed Enums](./closed-enums.md) — object lifecycle class / size cap enum

## 次に読む {#next-steps}

- [Provider Plugins](./providers.md) — curated 4 kind を 実 cloud / on-prem
  provider に解決する factory 一覧
- [Extending Takosumi](../extending.md) — 自前 kind を JSON-LD + materializer で
  publish する手順
- [AppSpec](./app-spec.md) — 各 component に kind を書く envelope 仕様
- [Operator Bootstrap](../operator/bootstrap.md) — kind に対応する materializer
  を kernel に attach する手順
- [Namespace Exports](./namespace-exports.md) — publish / listen の path grammar
  と registry semantics
