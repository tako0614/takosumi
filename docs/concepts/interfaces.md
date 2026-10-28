# Interface

Interface は、デプロイしたものが何を提供しているかを宣言する仕組みです。誰に使わせるかは
InterfaceBinding が決めるので、**宣言しただけでは誰も呼べません**。

## 宣言・選択・認可

- **Interface** — 提供する側の宣言。どんな入力を持ち、どの権限が必要かを書く
- **InterfaceLink** — 利用する Capsule の requirement key と、選んだ提供元の Interface / Capsule、
  要求・承認した権限を固定する連携の記録
- **InterfaceBinding** — 利用する側への認可。誰が、どの権限で使えるかを決める

秘密の値は Interface に載りません。Interface が公開するのは、明示的に対応付けた
非 secret の値だけです。

自分のリポジトリから画面を宣言して dashboard のホームに出す方法は、
[ホームにアプリを出す](../getting-started/home-launcher.md)にあります。このページは、
Interface API で直接扱う場合の説明です。

## 宣言する

Interface の正本 (正とする情報) は Takosumi の Interface API です。Capsule の blueprint から
生成する場合も、外部 Host が Form descriptor を投影する場合も、最終的には
同じ履歴へ収束します。Form descriptor の定義・実体化の authority は外部 Host 側です。

```http
POST /api/v1/interfaces
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
非 secret の JSON だけを書きます。owner は Workspace または Capsule です。旧 Resource
owner を読む compatibility code が残る endpoint でも、それは migration internal であり
新しい Interface authoring の入口ではありません。

アプリ間の連携で提供元にできるのは、同じ Workspace にインストールされた別の Capsule が所有する
Interface だけです。Workspace や operator が所有する Interface は Interface API で扱えても、
`interface.consume` の提供元候補にはなりません。

## 公開する値を対応付ける

`inputs` は、名前ごとにどこから値を取るかを書きます。`source` は 2 通りです。

| `source`          | 値の出どころ           | 一緒に書くもの                   |
| ----------------- | ---------------------- | -------------------------------- |
| `literal`         | 宣言に直接書いた値     | `value`                          |
| `capsule_output`  | Capsule の公開 Output  | `outputName`（API では `capsuleId` も） |

Interface API（`POST /api/v1/interfaces` の `spec.inputs`）では、宣言している Capsule 自身の
Output を読む場合も `capsuleId` を書きます。Capsule の blueprint（`interfaceBlueprints` や
repository の宣言）では `capsuleId` を書きません。宣言している Capsule が自動で入り、書くと
拒否されます。

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

## デプロイしたサービスから別の Capsule を使う

リポジトリの `.well-known/takosumi.json` では、`interfaces` がその Capsule の**提供する**
Interface を、`requires[].kind: "interface.consume"` が**使う** Interface の type、version、
permissions を宣言します。確認後に保存する InstallConfig では、それぞれ
`interfaceBlueprints` と `requiredInterfaces` になります。manifest に提供元の ID や認証情報を
埋め込みません。宣言の形は[Repository manifest](../reference/repository-manifest.md#requires)を参照してください。

インストール時には、宣言に合う `Resolved` の提供元を、同じ Workspace のアプリから選びます。
候補がなければ「あとで」が選ばれます。各要件に候補が 1 件だけあり、その Interface が private でなければ、
まず自動選択されます。複数の要件で同じ唯一の候補が自動選択された場合は、最初の要件の選択を残し、
後続の要件は提供元か「あとで」を選ぶ状態に戻ります。明示選択した提供元は自動選択より先に予約されるため、
同じ Interface を使う後続の自動選択も選ぶ状態に戻ります。private の提供元や候補が複数ある要件は、
提供元か「あとで」を明示して選びます。
選択は InterfaceLink に保存され、提供元の Interface と Capsule に固定されます。後から
2 つ目の提供元を追加しても、現在の提供元が使えなくなっても、別の候補へ自動で切り替えません。

連携の状態は `pending_approval`、`active`、`declined`、`revoked` のいずれかです。
要求した権限と承認された権限を別に記録し、active な連携だけが通常の InterfaceBinding を作れます。
承認は差し替え可能な policy が判断します。現在の Workspace 構成では、同じ Workspace の
連携を即時承認します。連携が未設定でも OIDC のサインインは続き、その連携の Binding は作りません。
アプリの更新で権限の順序が変わったり減ったりしても、承認済みの範囲で連携を続けます。
権限が増えた場合は health が `reapproval_required` になり、連携先を選び直して承認するまで新しい権限を付与しません。

実行時は、active な連携が指す提供元と、呼ぶ Principal の Ready な InterfaceBinding、permission を
確かめます。Interface の値や認証情報を、consumer の OpenTofu 変数や state に流し込みません。
host の runtime に渡す実体（materialization）は、alias ごとの権限に絞ります。
provider credential、account id、native resource id、bearer token は
渡しません。

Binding の revoke、Interface generation の変更、permission の変更後に、
古い実体（materialization）に戻して使ってはいけません。host は新しい runtime version を
作り直すか、呼び出しを失敗させて安全側に止めます。

これは Interface の認可機能です。OpenTofu module が Cloudflare / AWS / Takoform などの
provider を直接使う経路を置き換えません。

## 連携を確認・変更する

アプリページの連携には、使っている側の `links.uses` と、使われている側の `links.usedBy` が
表示されます。未設定は `interface_link_unset`、利用不可は `interface_link_unavailable`、
提供元が削除予約中の連携は `interface_link_degraded` として通知されます。連携先を直す操作は
`fix_interface_link` です。

候補の取得・選び直し・解除は、アプリの管理権限で[連携 API](../reference/api.md#interface-links)を
使います。選び直しは Plan を作らず、新しい提供元への Binding を作ってから旧 Binding を取り消します。
更新には、読んだ `generation` を `expectedGeneration` として渡します。

アンインストールの確認には、そのアプリを使う `uninstall.impact.usedBy` が表示されます。
提供元をアンインストールしても、利用側のアプリは残ります。連携の選択を別の提供元に変えたり、
連携の状態を勝手に書き換えたりせず、現在の提供元から利用可能性を計算します。

ストアは、Git URL と module の一致から「インストール済み」と「開く」を表示します。
同じアプリをもう一度インストールしたいときは「もう1つ入れる」を選べます。新しいインストールは独立したアプリで、
データや設定は共有しません。

## 状態と認可を読む

例の `$TAKOSUMI_DEPLOY_CONTROL_TOKEN` には、`read` を持つ[発行した token](../reference/cli.md#トークンを発行する)を入れます。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example/bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## 呼び出し用のトークン

認可済みの Interface に対して、短時間だけ有効なトークンを発行します。要求できるのは、
その Interface を呼ぶ実行環境に渡された OAuth アクセストークンだけです。ここまでの例で
使ってきた control plane のトークンで叩くと `403` が返ります。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example/token" \
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

接続元 Capsule の Output や Interface generation が変わると、関連する Binding の版が
解決し直されます。
デプロイ直後に一時的に `Unknown` になることがあるのはこのためです。

## 関連

- [Resource migration internals](./resources.md)
- [状態と出力](./state-and-outputs.md)
