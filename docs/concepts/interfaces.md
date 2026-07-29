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

| `source`          | 値の出どころ           | 一緒に書くもの                   |
| ----------------- | ---------------------- | -------------------------------- |
| `literal`         | 宣言に直接書いた値     | `value`                          |
| `capsule_output`  | Capsule の公開 Output  | `outputName`、任意で `capsuleId` |
| `resource_output` | Resource の公開 Output | `resourceId`、`outputName`       |

`capsule_output` で `capsuleId` を省くと、宣言している Capsule 自身の Output を
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

`resourceUriInput` には、トークンの宛先として使う input の名前を書きます。解決された
値は Interface の `status.resolvedInputs`、その出どころは `status.provenance` で
読めます。

## デプロイ済みアプリから Resource を使う

Interface は提供側の宣言ですが、host は同じ Interface / InterfaceBinding 台帳を使って、
デプロイ済みアプリに Resource への接続を渡すこともできます。

この場合、宣言は2種類を混ぜません。

- `InstallConfig.interfaceBlueprints` は、その Capsule が**提供する** Interface の候補です。
- service-side の `hostRuntimeMaterialization.requirements` は、その hosted runtime が
  **利用する** Resource の alias と必要権限です。repository manifest、Output、
  provider 設定ではありません。

host は consumer Resource が Ready になったあと、対象 Resource の generation、
Interface、Ready な InterfaceBinding、permission、audience を解決します。runtime
には Fetch-compatible gateway と、alias ごとの exact authority を持つ materialization
だけを渡します。provider credential、account id、native resource id、bearer token は
渡しません。

Binding の revoke、Resource generation の変更、permission や audience の変更後に、
古い materialization へ fallback してはいけません。host は新しい exact runtime
version を作るか、呼び出しを fail closed にします。

これは host が明示的に提供する機能です。OpenTofu module が Cloudflare / AWS などの
provider を直接使う経路を置き換えません。

## 状態と認可を読む

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example/bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## 呼び出し用のトークン

認可済みの Interface に対して、短時間だけ有効なトークンを発行します。要求できるのは、
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
- **有効期間は最大 60 秒で、更新用トークンはありません。** 必要なときに取り直します
- 使える範囲は要求した権限と、その Interface が示す宛先に限られます
- token の文字列形式は発行する host が決めます。同梱の Accounts 実装は `taksrv_`
  から始まる token を返しますが、client は接頭辞で挙動を変えてはいけません

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
