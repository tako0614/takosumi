# Output convention から Interface への一回限りの移行

この手順は、pre-v1 の `service_exports` / `service_bindings` /
`app_deployment` を runtime discovery として扱っていた Capsule を、明示的な
`Interface` へ移行する operator-only 手順です。旧 Output は通常の OpenTofu
Output として残り得ますが、fallback authority には戻しません。

## 不変条件

- report は Output の名前・ID・digest だけを返し、値を返しません。
- token / password / bearer / signing key など secret-shaped な Output 名は候補に
  出しません。値を Interface や audit へコピーしません。
- known first-party Capsule は現在の service-side `interfaceBlueprints` だけを正本に
  します。request から blueprint を差し替えられません。
- unknown third-party Capsule は Workspace owner/operator が Output 名、Interface
  type/version、入力名を明示選択します。well-known Output 名から推測しません。
- confirmation は Capsule `updatedAt`、InstallConfig `updatedAt`、current Output ID /
  digest、Output名digest、blueprint digestを report と完全一致させます。
- Interface が `Resolved` になり、永続 Activity evidence が書けた場合だけ完了です。
  evidence 書き込み前に停止しても、同じ確認requestは安全に再実行できます。

## 1. report

```http
GET /internal/v1/workspaces/{workspaceId}/migrations/output-interfaces
Authorization: Bearer {deploy-control-token}
```

レスポンスには次を含みます。

- `candidates`: exact fence と、値を含まない `availableOutputNames`
- `completed`: 永続 migration evidence と Interface ID
- `issues`: Output pointer不整合、missing Output、retired blueprintなどの安全側に停止する理由

`mode=service_blueprints` なら `candidate` をそのまま確認します。
`mode=owner_selection_required` なら、ownerとInterface 利用側が合意した明示
`selection` を付けます。

## 2. known first-party の確認

```http
POST /internal/v1/workspaces/{workspaceId}/migrations/output-interfaces
Authorization: Bearer {deploy-control-token}
Content-Type: application/json

{
  "candidate": { "...": "GET response の candidate を変更せずコピー" }
}
```

Takosumi はInstallConfigに保存済みのblueprintを一度だけmaterializeします。既に同じ
blueprint由来のInterfaceがあれば再利用し、operatorの後続編集やretireを上書きしません。

## 3. unknown third-party の確認

```json
{
  "candidate": { "...": "GET response の candidate を変更せずコピー" },
  "selection": {
    "name": "main-mcp",
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": { "transport": "streamable-http" },
    "inputName": "endpoint",
    "outputName": "launch_url",
    "access": {
      "visibility": "private",
      "resourceUriInput": "endpoint"
    }
  }
}
```

必要なら `pointer` にRFC 6901 JSON Pointerを指定できます。選択したOutput名はreportの
`availableOutputNames` に存在する必要があります。secret値を `document` やliteralへ
移さず、runtime credentialは`oauth2` InterfaceBindingまたは明示Secret materializerへ
移してrotateします。

## 4. 完了確認

もう一度GETし、対象Capsuleが`completed`にあり、返された`evidenceEventId`が
Workspace Activityで `interface.output_convention_migrated` として読めることを確認します。
runtime 利用側はInterface APIとReady InterfaceBindingだけを読みます。shadow compareを
行う場合も旧Output discoveryは観測対象に限定し、fallbackとして使いません。

移行後にInterfaceが不要になった場合は通常のInterface retireを使います。旧Output
conventionを再有効化するrollbackはありません。
