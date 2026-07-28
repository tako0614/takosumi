# Service Form host API (takoform v0)

Takosumi は Service Form の host protocol である takoform v0 を `/takoform/v0` で
話します。この面を使うと、Terraform provider でも自作の client でも、Form が
定義した 1 件のサービスを HTTP だけで作成・読み取り・差分確認・取り込み・削除
できます。protocol は host に依らない共通仕様なので、同じ client を takoform v0 を
話す別の host にも向けられます。

ここでは送受信する JSON と HTTP の約束事をまとめます。宣言した内容がどう解決されて
実物になるかは [Resource](../concepts/resources.md) を読んでください。

以降の例では次の 2 つを設定しておきます。

```bash
export TAKOFORM_HOST=https://takosumi.example.com
export TAKOFORM_TOKEN=takpat_example
```

## 入口を確認する

`/.well-known/takoform` は認証なしで読めます。まずここを引いて、host が takoform
を話すかどうかと base URL を確かめます。

```bash
curl -sS "$TAKOFORM_HOST/.well-known/takoform"
```

```json
{
  "protocols": ["v0"],
  "features": {
    "service_forms": true,
    "exact_form_ref": true,
    "optimistic_concurrency": true,
    "idempotent_lifecycle": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/takoform/v0",
    "forms": "https://takosumi.example.com/takoform/v0/forms",
    "capabilities": "https://takosumi.example.com/v1/capabilities",
    "compatibility_api": "https://takosumi.example.com/v1"
  }
}
```

`endpoints` の各 URL は要求した origin から組み立てられます。この面を公開して
いない endpoint では `/.well-known/takoform` が `404` を返すので、client は
discovery の成否で分岐できます。公開している endpoint は
`GET /v1/capabilities` の `features.compatibility_profiles` にも
`compat.takoform.v1` を並べます。

## 認証

discovery 以外のすべての要求に bearer token を付けます。

```http
Authorization: Bearer <token>
```

token をどう発行するかは endpoint の運用者が決めます。Takosumi Cloud では
Takosumi Accounts の personal access token がそのまま使えます。認証に失敗すると
`401 unauthenticated`、権限が足りなければ `403 permission_denied` が返ります。

複数の Workspace を持つ endpoint では、要求の `workspace` が token で検証済みの
Workspace id と一致している必要があります。別の Workspace を指すと `403` です。

## Workspace と Form の指定

要求ごとに、対象の Workspace と、使う Form の完全一致識別子を指定します。

Workspace を指すクエリの名前は **`workspace`** です。読み取り・差分確認・削除では
クエリに、preview・apply・import では JSON body の `workspace` field に書きます。

Form の完全一致識別子 (InstalledFormReference) は 4 つの値の組です。

| field | 形式 | 例 |
| --- | --- | --- |
| `type` | 先頭は小文字英字、以降は小文字英数字と `_`。1〜64 文字 | `object_bucket` |
| `version` | SemVer | `1.2.0` |
| `schemaDigest` | `sha256:` + 小文字 16 進 64 桁 | `sha256:5f0c…` |
| `packageDigest` | `sha256:` + 小文字 16 進 64 桁 | `sha256:0a3d…` |

クエリで渡すときは 4 つすべてを同じ名前で並べます。1 つでも欠けると
`400 invalid_argument` です。`latest` のような曖昧な指定は受け付けません。

```bash
export TAKOFORM_FORM="type=object_bucket&version=1.2.0"
TAKOFORM_FORM="$TAKOFORM_FORM&schemaDigest=sha256:5f0c9a1d3b7e42c8a6f1d0b93e7c2a48d15b6e39f04c7a82b91d3e6f5c08a7b2"
TAKOFORM_FORM="$TAKOFORM_FORM&packageDigest=sha256:0a3d7c19e5b84f26c7e1908b4d2a6f5318b0d6e47c93a2f56e2c5a08d1f7b493"
export TAKOFORM_FORM
```

保存済みの Resource は作られたときの Form 識別子に固定されます。digest だけを
差し替えて同じ Resource を指すと `409 form_identity_conflict` になります。

## エンドポイント

| メソッド | パス | 必須クエリ | 必須ヘッダ |
| --- | --- | --- | --- |
| GET | `/.well-known/takoform` | なし | なし |
| GET | `/takoform/v0/forms` | `workspace` | `authorization` |
| POST | `/takoform/v0/resources/preview` | なし | `authorization` |
| PUT | `/takoform/v0/resources/{type}/{name}` | なし | `authorization` / `idempotency-key` / `if-none-match` か `if-match` |
| POST | `/takoform/v0/resources/{type}/{name}/import` | なし | `authorization` / `idempotency-key` / `if-none-match` か `if-match` |
| GET | `/takoform/v0/resources` | `workspace` と Form の 4 field | `authorization` |
| GET | `/takoform/v0/resources/{type}/{name}` | `workspace` と Form の 4 field | `authorization` |
| POST | `/takoform/v0/resources/{type}/{name}/refresh` | `workspace` と Form の 4 field | `authorization` / `idempotency-key` / `if-match` |
| POST | `/takoform/v0/resources/{type}/{name}/sync` | `workspace` と Form の 4 field | `authorization` / `idempotency-key` / `if-match` |
| DELETE | `/takoform/v0/resources/{type}/{name}` | `workspace` と Form の 4 field | `authorization` / `idempotency-key` / `if-match` |

一覧を返す 2 つの endpoint は `limit` と `cursor` も受け取ります。`limit` の既定は
100 件、最大も 100 件です。最終ページ以外では `nextCursor` が返るので、中身を
解釈せず次の `cursor` にそのまま渡します。

## Resource の表現

wire の Resource は入れ子のない 1 枚の JSON です。

```json
{
  "type": "object_bucket",
  "form": {
    "type": "object_bucket",
    "version": "1.2.0",
    "schemaDigest": "sha256:5f0c9a1d3b7e42c8a6f1d0b93e7c2a48d15b6e39f04c7a82b91d3e6f5c08a7b2",
    "packageDigest": "sha256:0a3d7c19e5b84f26c7e1908b4d2a6f5318b0d6e47c93a2f56e2c5a08d1f7b493"
  },
  "workspace": "workspace_1",
  "name": "assets",
  "serial": "3",
  "config": { "name": "assets", "storageClass": "standard" },
  "attributes": { "portability": "portable" },
  "id": "tkrn:workspace_1:ObjectBucket:assets"
}
```

| field | 書き込み | 意味 |
| --- | --- | --- |
| `type` | 必須 | Form の型 token。path の `{type}` と一致させます |
| `form` | 必須 | 完全一致の Form 識別子。`form.type` も `type` と一致させます |
| `workspace` | 必須 | 対象の Workspace |
| `name` | 必須 | Resource 名。path の `{name}` と一致させます |
| `config` | 必須 | あるべき状態。中身は Form の schema が決めます |
| `project` | 任意 | 所属 Project |
| `environment` | 任意 | 所属環境 |
| `nativeId` | import のみ | 取り込む実物の provider 側識別子 |
| `review` | apply のみ | preview が返した `planDigest` を入れた object |
| `serial` | 読み取り専用 | 10 進の世代番号。`ETag` と同じ値です |
| `attributes` | 読み取り専用 | 観測済みの値 |
| `id` | 読み取り専用 | `tkrn:{workspace}:{Kind}:{name}` |

body に書けるのはこの表の field だけです。ほかの key を入れると
`400 invalid_argument` で、どの key が原因かが `message` に入ります。応答をその
まま送り返せるように `serial` / `attributes` / `id` も受け付けますが、書き込みには
使いません。

`attributes` は Takosumi が状態を観測したあとに付き、現在は移植性の評価を表す
`portability` だけを含みます。値は `portable`、`mostly_portable`、`partial`、
`locked_in` のいずれかです。Form が公開する実行時の値は Interface から取得します
([Interface](../concepts/interfaces.md))。

## 同時実行と再送

書き込みは楽観ロックで直列化します。応答の `ETag` は `serial` を二重引用符で
囲んだものです。

| 操作 | 前提条件ヘッダ |
| --- | --- |
| 作成 | `if-none-match: *` |
| 更新 | `if-match: "3"` |
| refresh / sync / 削除 | `if-match: "3"` |

`if-match` の値は引用符付きの 10 進整数 1 つだけです。`if-match` と `if-none-match`
を同時に付けると `400` になります。すでに存在する Resource を指す要求 (読み取り、refresh、sync、
削除) に `if-none-match` を付けても `400` です。前提条件が現在の `serial` と
食い違うときは `412 serial_conflict` が返ります。

`PUT`、`import`、`refresh`、`sync`、`DELETE` には `idempotency-key` ヘッダが必要
です。先頭は英数字、全体で 8〜128 文字、使える文字は `A-Za-z0-9` と `._:/-` です。
同じ値が応答の `idempotency-key` ヘッダに返ります。

同じ内容・同じ前提条件で apply を送り直したとき、その適用がすでに完了していれば
やり直さずに完了済みの Resource を返します。存在しない Resource への削除も `204`
で成功します。通信が切れたら同じ要求をそのまま再送してください。

## Form の利用可否を読む

その principal がいまその Form を使えるかどうかを返します。Form の 4 field は
任意で、付ければ 1 件に絞り込めます。

```bash
curl -sS -H "authorization: Bearer $TAKOFORM_TOKEN" \
  "$TAKOFORM_HOST/takoform/v0/forms?workspace=workspace_1&$TAKOFORM_FORM"
```

```json
{
  "forms": [
    {
      "form": {
        "type": "object_bucket",
        "version": "1.2.0",
        "schemaDigest": "sha256:5f0c…",
        "packageDigest": "sha256:0a3d…"
      },
      "definitionKnown": true,
      "installed": true,
      "executable": true,
      "activated": true,
      "availableToPrincipal": true,
      "operations": ["create", "read", "update", "delete", "import"],
      "compatibleAdapterIds": ["opentofu"],
      "eligibleTargetPoolClasses": ["standard"],
      "deprecated": false
    }
  ]
}
```

`operations` に並ぶ token は `create`、`read`、`update`、`delete`、`import`、
`refresh`、`sync`、`drift` です。`executable` と `availableToPrincipal` が `false`
のときは `executableReason` と `availabilityReason` に理由 token が入ります。

この endpoint には読み取り scope が必要です。token の scope に `forms:read`、
`resources:read`、`resources:*`、`read`、`admin`、`*` のいずれかがあれば通ります。

preview、apply、import は同じ判定を書き込み前に行います。判定に落ちたときの
応答は次のとおりです。

| 状態 | 応答 |
| --- | --- |
| その識別子を host が知らない | `404 form_unknown` |
| package が install されていない | `409 form_not_installed` |
| 実行できない、または有効化されていない | `409 form_unavailable` |
| その操作に対応していない | `409 form_unavailable` |
| principal に公開されていない | `403 permission_denied` |

## 適用の内容を確認する

preview は実物に触れず、これから何が起きるかを返します。`workspace` は body に
書きます。

```bash
curl -sS -X POST "$TAKOFORM_HOST/takoform/v0/resources/preview" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "type": "object_bucket",
    "form": {
      "type": "object_bucket",
      "version": "1.2.0",
      "schemaDigest": "sha256:5f0c9a1d3b7e42c8a6f1d0b93e7c2a48d15b6e39f04c7a82b91d3e6f5c08a7b2",
      "packageDigest": "sha256:0a3d7c19e5b84f26c7e1908b4d2a6f5318b0d6e47c93a2f56e2c5a08d1f7b493"
    },
    "workspace": "workspace_1",
    "name": "assets",
    "config": { "name": "assets", "storageClass": "standard" }
  }'
```

```json
{
  "resource": { "type": "object_bucket", "name": "assets" },
  "review": {
    "planDigest": "sha256:7d41…",
    "specDigest": "sha256:2b90…"
  },
  "summary": "portable resource preview ready"
}
```

`resource` は前の節で示した Resource と同じ形です。例では field を一部だけ
示しています。
`review.planDigest` は次の apply でそのまま送ります。

## 作成と更新

apply は `PUT` です。path の `{type}` と `{name}` は body の `type` と `name` に
一致させます。食い違うと `400` です。

```bash
curl -sS -X PUT "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/assets" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H "content-type: application/json" \
  -H "if-none-match: *" \
  -H "idempotency-key: create-assets-0001" \
  -d '{
    "type": "object_bucket",
    "form": {
      "type": "object_bucket",
      "version": "1.2.0",
      "schemaDigest": "sha256:5f0c9a1d3b7e42c8a6f1d0b93e7c2a48d15b6e39f04c7a82b91d3e6f5c08a7b2",
      "packageDigest": "sha256:0a3d7c19e5b84f26c7e1908b4d2a6f5318b0d6e47c93a2f56e2c5a08d1f7b493"
    },
    "workspace": "workspace_1",
    "name": "assets",
    "config": { "name": "assets", "storageClass": "standard" },
    "review": { "planDigest": "sha256:7d41…" }
  }'
```

応答は Resource が 1 枚そのまま返り、`ETag` に新しい `serial` が入ります。更新
するときは `if-none-match: *` を `if-match: "3"` に置き換えます。

## 既存の実物を取り込む

すでに provider 側に存在するものを Takosumi の記録に入れます。body は apply と同じ
形に `nativeId` を足したもので、`review` は要りません。

```bash
curl -sS -X POST \
  "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/legacy-assets/import" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H "content-type: application/json" \
  -H "if-none-match: *" \
  -H "idempotency-key: import-legacy-assets-0001" \
  -d '{
    "type": "object_bucket",
    "form": {
      "type": "object_bucket",
      "version": "1.2.0",
      "schemaDigest": "sha256:5f0c9a1d3b7e42c8a6f1d0b93e7c2a48d15b6e39f04c7a82b91d3e6f5c08a7b2",
      "packageDigest": "sha256:0a3d7c19e5b84f26c7e1908b4d2a6f5318b0d6e47c93a2f56e2c5a08d1f7b493"
    },
    "workspace": "workspace_1",
    "name": "legacy-assets",
    "config": { "name": "legacy-assets", "storageClass": "standard" },
    "nativeId": "legacy-assets-bucket"
  }'
```

```json
{
  "resource": { "type": "object_bucket", "name": "legacy-assets" },
  "import": { "summary": "portable import completed" }
}
```

`nativeId` は provider が付けている識別子です。認証情報を渡さないでください。

## 読み取りと一覧

1 件を読むときは `workspace` と Form の 4 field をクエリに付けます。

```bash
curl -sS -H "authorization: Bearer $TAKOFORM_TOKEN" \
  "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/assets?workspace=workspace_1&$TAKOFORM_FORM"
```

一覧は同じ Form 識別子を持つ Resource だけを返します。

```bash
curl -sS -H "authorization: Bearer $TAKOFORM_TOKEN" \
  "$TAKOFORM_HOST/takoform/v0/resources?workspace=workspace_1&$TAKOFORM_FORM&limit=100"
```

```json
{
  "resources": [{ "type": "object_bucket", "name": "assets" }],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2…"
}
```

絞り込みは Workspace 全体を読んだページの中で行うため、`resources` が空でも
`nextCursor` があれば続きのページに対象が残っています。`nextCursor` が返らなく
なるまで読んでください。

## 差分を確認する / 状態を取り直す

`refresh` は読み取り専用の差分確認です。実物を変更せず、いま食い違いがあるかどう
かだけを返します。

```bash
curl -sS -X POST \
  "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/assets/refresh?workspace=workspace_1&$TAKOFORM_FORM" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H 'if-match: "3"' \
  -H "idempotency-key: refresh-assets-0001"
```

```json
{
  "resource": { "type": "object_bucket", "name": "assets" },
  "observation": {
    "status": "current",
    "summary": "portable drift check current"
  }
}
```

`observation.status` は `current`、`drifted`、`missing` のいずれかです。差分が
見つかっても自動では適用しません。

`sync` は実物の状態を読み直し、Takosumi 側の状態と公開値を更新します。

```bash
curl -sS -X POST \
  "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/assets/sync?workspace=workspace_1&$TAKOFORM_FORM" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H 'if-match: "3"' \
  -H "idempotency-key: sync-assets-0001"
```

```json
{
  "resource": { "type": "object_bucket", "name": "assets" },
  "sync": { "summary": "portable sync completed" }
}
```

どちらの応答にも、host が Run を作った場合は `runId` が入ります。

## 削除

```bash
curl -sS -X DELETE \
  "$TAKOFORM_HOST/takoform/v0/resources/object_bucket/assets?workspace=workspace_1&$TAKOFORM_FORM" \
  -H "authorization: Bearer $TAKOFORM_TOKEN" \
  -H 'if-match: "3"' \
  -H "idempotency-key: delete-assets-0001"
```

成功すると本文なしの `204` が返ります。対象がすでに無い場合も `204` です。

## 使える型 token

takoform v0 の `type` は snake_case です。Takosumi は次の 10 種を対応付けます。

| takoform の `type` | Takosumi の kind |
| --- | --- |
| `edge_worker` | `EdgeWorker` |
| `object_bucket` | `ObjectBucket` |
| `kv_store` | `KVStore` |
| `queue` | `Queue` |
| `sql_database` | `SQLDatabase` |
| `container_service` | `ContainerService` |
| `vector_index` | `VectorIndex` |
| `durable_workflow` | `DurableWorkflow` |
| `stateful_actor_namespace` | `StatefulActorNamespace` |
| `schedule` | `Schedule` |

この表にない `type` は `400 invalid_argument` です。実際にどの型を使えるかは
endpoint ごとに違うので、`/takoform/v0/forms` で確かめます。

Takosumi の `/v1` API を知っている人向けに、語彙の対応を挙げます。

| takoform v0 | Takosumi `/v1` | 意味 |
| --- | --- | --- |
| `workspace` | `space` | 対象の Workspace |
| `type` | `kind` | 型の名前 |
| `config` | `spec` | あるべき状態 |
| `serial` | `metadata.generation` | 世代番号 |
| `refresh` | `observe` | 読み取り専用の差分確認 |
| `sync` | `refresh` | 状態と公開値の取り直し |

## エラー

失敗の応答はすべて同じ封筒です。

```json
{
  "error": {
    "code": "serial_conflict",
    "message": "serial precondition failed",
    "requestId": "req_01J8ZK2Q",
    "retryable": false
  }
}
```

分岐には `code` を使います。`retryable` が `true` のときだけ、同じ
`idempotency-key` で再送する価値があります。host 内部の詳細コードが `hostCode` に
付くことがありますが、これは調査用です。

| `code` | HTTP | 起きる状況 |
| --- | --- | --- |
| `invalid_argument` | 400 | body やクエリが契約に合っていません |
| `unauthenticated` | 401 | token が無いか無効です |
| `permission_denied` | 403 | scope が足りないか、その Form を使えません |
| `policy_denied` | 403 | policy が適用を止めました |
| `form_unknown` | 404 | その完全一致識別子を host が知りません |
| `resource_not_found` | 404 | その Resource がありません |
| `form_not_installed` | 409 | Form package が install されていません |
| `form_unavailable` | 409 | Form を実行できないか、その操作に対応していません |
| `form_identity_conflict` | 409 | 保存済み Resource が別の Form 識別子に固定されています |
| `resource_busy` | 409 | ほかの操作が進行中です |
| `import_conflict` | 409 | 取り込みの前提が崩れています |
| `serial_conflict` | 412 | `if-match` / `if-none-match` が現在の状態と合いません |
| `backend_unavailable` | 503 | host の下位が応答できません |
| `internal_error` | 500 | host が想定していない失敗をしました |

`internal_error` だけは takoform の route ではなく共通の例外処理から返るため、
`retryable` が付きません。ほかの code では必ず `retryable` が入ります。

## host の適合性を検査する

Takosumi のリポジトリには、takoform v0 の host を外側から一通り実行する検査
runner が入っています。discovery から利用可否、preview、apply、再送、読み取り、
digest 差し替えの拒否、refresh、sync、削除までを通し、digest 付きの報告を
標準出力に書きます。

```bash
bun run service-form:host-conformance \
  --endpoint https://takosumi.example.com \
  --space workspace_1 \
  --name conformance-assets \
  --identity form.json \
  --desired config.json \
  --token-env TAKOFORM_TOKEN
```

`--identity` には完全一致の Form 識別子、`--desired` には `config` に入れる JSON
を置きます。token は `--token-env` で指定した環境変数からだけ読みます。既存の実物
を取り込む検査も行うときは `--import-native-id-env` を足します。

## 関連

- [Resource](../concepts/resources.md)
- [Interface](../concepts/interfaces.md)
- [Takosumi API](./api.md)
