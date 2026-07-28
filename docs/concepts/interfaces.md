# Interface

Interface は、デプロイしたものが何を提供しているかを宣言する仕組みです。誰に使わせるかは
InterfaceBinding が決めるので、**宣言しただけでは誰も呼べません**。

## 役割の分担

- **Interface** — 提供する側の宣言。どんな入力を持ち、どの権限が必要かを書く
- **InterfaceBinding** — 利用する側への認可。誰が、どの権限で使えるかを決める

秘密の値は Interface に載りません。Interface が公開するのは、明示的に対応付けた
非 secret の値だけです。

## 宣言する

Interface の正本は Takosumi の Interface API です。Capsule の blueprint または
Takoform の Form descriptor から materialize する場合も、最終的には同じ台帳へ
収束します。

```http
POST /v1/interfaces
Authorization: Bearer <control token>
Content-Type: application/json
```

```json
{
  "workspaceId": "ws_example",
  "name": "primary-mcp",
  "ownerRef": {
    "kind": "Capsule",
    "id": "capsule_example"
  },
  "spec": {
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": {
      "transport": "streamable-http"
    },
    "inputs": {
      "endpoint": {
        "source": "capsule_output",
        "capsuleId": "capsule_example",
        "outputName": "mcp_url"
      }
    },
    "access": {
      "visibility": "workspace",
      "resourceUriInput": "endpoint"
    }
  }
}
```

`visibility` は `private` / `workspace` / `public` のいずれかです。`document` には
非 secret の JSON だけを書きます。owner は Workspace / Capsule / Resource の
いずれかで、別の仕組みに複製しません。

型付きの Resource にも `interfaces` という欄がありますが、役割は違います。こちらは
その Resource にどの使い方ができてほしいかを並べるもので、Takosumi は挙げられた
すべてを備える Target を選びます。

```json
{
  "kind": "ObjectBucket",
  "metadata": { "name": "assets", "space": "prod" },
  "spec": {
    "name": "assets",
    "interfaces": ["s3_api", "signed_url"]
  }
}
```

## 公開する値を対応付ける

`inputs` は、名前ごとにどこから値を取るかを書きます。`source` は 3 通りです。

| `source` | 値の出どころ | 一緒に書くもの |
| --- | --- | --- |
| `literal` | 宣言に直接書いた値 | `value` |
| `capsule_output` | Capsule の公開 Output | `output_name`、任意で `capsule_id` |
| `resource_output` | Resource の公開 Output | `resource_id`、`output_name` |

`capsule_output` で `capsule_id` を省くと、宣言している Capsule 自身の Output を
読みます。

Output の値が構造を持つときは `pointer` で一部だけを取り出せます。書き方は RFC 6901 の
JSON Pointer です。

```json
{
  "inputs": {
    "host": {
      "source": "capsule_output",
      "capsuleId": "capsule_example",
      "outputName": "endpoint",
      "pointer": "/hostname"
    }
  }
}
```

`resource_uri_input` には、トークンの宛先として使う input の名前を書きます。解決された
値は Interface の `status.resolvedInputs`、その出どころは `status.provenance` で
読めます。

## 状態と認可を読む

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example/bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## 呼び出し用のトークン

認可済みの Interface に対して、その場限りのトークンを発行します。要求できるのは、
その Interface を呼ぶ実行環境に渡された OAuth アクセストークンだけです。ここまでの例で
使ってきた control plane のトークンで叩くと `403` が返ります。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example/token" \
  -H "authorization: Bearer $TAKOSUMI_RUNTIME_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "permission": "example.invoke" }'
```

返るトークンの性質は次のとおりです。

- 応答は `access_token` / `token_type` / `expires_in` / `expires_at` / `scope` /
  `resource` からなる OAuth 形式です
- 接頭辞は `taksrv_` です
- **有効期間はごく短く、更新用トークンはありません。** 都度取り直します
- 使える範囲は要求した権限と、その Interface が示す宛先に限られます

長期間使い回すためのものではないので、実行のたびに取得する前提で組んでください。

## 通らないときに見る順序

1. Interface の `status.phase` が `Resolved` か
2. 呼ぶ側に対する InterfaceBinding があり、その `status.phase` が `Ready` か
3. 要求した権限がその Binding に含まれているか
4. トークンが期限切れでないか

いずれかを満たさない場合、Takosumi はその場で**停止します**。

Resource の refresh が成功すると、関連する Interface の版が解決し直されます。
デプロイ直後に一時的に `Unknown` になることがあるのはこのためです。

## 関連

- [Resource](./resources.md)
- [状態と出力](./state-and-outputs.md)
