# ホームにアプリを出す

自分のソフトウェアに、使う人が開く画面（web アプリ）があるなら、dashboard のホーム
（**あなたのアプリ**）にそれを開くタイルを出せます。追加が終わった画面の **サービスを開く** も、
その画面を新しいタブで開くようになります。宣言は、リポジトリの `.well-known/takosumi.json`
（[Repository manifest](../reference/repository-manifest.md)）に書きます。

宣言が無いサービスはホームに出ず、**ワークロード** の一覧にだけ並びます。

## 用意するもの

1. 画面の URL を返す OpenTofu の `output`
2. その `output` を指す宣言を書いた `.well-known/takosumi.json`

### 1. 画面の URL を返す output

```hcl
variable "hostname" {
  type    = string
  default = "notes.example.com"
}

output "launch_url" {
  description = "利用者が開く画面の URL"
  value       = "https://${var.hostname}"
}
```

この例は変数の既定値から URL を作っています。実際には、module が作った resource（公開した
Worker やサーバーなど）のアドレスから作ります。既定値の無い変数を使うときは、その変数を
`.well-known/takosumi.json` の `inputs` に宣言して、追加する人が入力できるようにします
（[Repository manifest](../reference/repository-manifest.md#inputs)）。

- 値は `https://` か `http://` で始まる URL にします。ユーザー名やパスワード、`#` 以降の
  fragment、`token` のような認証情報らしい名前の query を含む URL はタイルになりません。
- `sensitive` や `ephemeral` にはしません。

### 2. `.well-known/takosumi.json`

リポジトリの最上位に置きます。module が `deploy/opentofu` にある場合の例です。

```json
{
  "apiVersion": "takosumi.com/v2.4",
  "kind": "Repository",
  "install": {
    "modules": {
      "deploy/opentofu": {
        "inputs": [],
        "interfaces": [
          {
            "key": "launcher",
            "name": "notes.launcher",
            "spec": {
              "type": "interface.ui.surface",
              "version": "1",
              "document": {
                "launcher": true,
                "display": { "title": "Notes", "icon": "/icon.svg" }
              },
              "inputs": {
                "url": {
                  "source": "output",
                  "outputName": "launch_url",
                  "outputType": "url"
                }
              },
              "access": { "visibility": "workspace" }
            },
            "bindingRequests": [
              {
                "key": "installer",
                "subject": { "source": "installing_principal" },
                "permissions": ["ui.open"],
                "delivery": { "type": "none" }
              }
            ]
          }
        ]
      }
    }
  }
}
```

書き換えるのは次の値です。ほかはこのまま使います。

| 場所 | 書くもの |
| --- | --- |
| `install.modules` の key | module のフォルダ。**リポジトリの最上位から**書きます（最上位なら `.`）。追加リンクが `sourcePath=infra&path=deploy/opentofu` なら、key は `infra/deploy/opentofu` です |
| `name` | この宣言の名前。英字で始め、英数字と `_`、`.`、`-` だけ（128 文字まで） |
| `display.title` | タイルに出す名前（256 文字まで） |
| `display.icon` | タイルのアイコン（下の表）。省くと名前の頭文字が出ます |
| `outputName` | 1 で作った output の名前 |

`display` には、ほかに `sortOrder`（数。小さいほど前に並びます）、`category`（64 文字まで）、
`description`（1,024 文字まで）を書けます。`category` は今の dashboard では、アイコンの無い
タイルの色分けにだけ使われます（`site`、`storage`、`worker`）。`description` は今の dashboard
には表示されません。

| `display.icon` の形 | 例 | 意味 |
| --- | --- | --- |
| `/` で始まるパス | `/icon.svg` | 画面の URL と同じ origin の画像。アプリがその画像を配信している必要があります |
| `https://` の URL | `https://cdn.example.com/notes.svg` | その画像 |
| 16 文字までの短い文字 | `📝` | 文字のアイコン（`/`、`.`、`:` を含まないもの） |

`bindingRequests` は、追加した本人に、その画面を開く利用許可（`ui.open`）を作るよう頼む
部分です。ホームのタイルは、この利用許可を持つ人にだけ表示されます。また、サービスの状態が
**デプロイ済み** か **更新があります** のときだけ表示されます。

## 追加した人に見えるもの

1. 追加の最後に「サービスを準備しています」と表示され、画面の URL が使えるようになるのを
   待ちます。
2. **追加できました** の画面の **サービスを開く** で、画面が新しいタブで開きます（画面の URL を
   確かめられなかったときは、代わりにサービスのページが開きます）。
3. ホームの **あなたのアプリ** に、アイコンと `display.title`（無ければサービス名）のタイルが
   出ます。押すと画面が新しいタブで開きます。アイコンが無いときは名前の頭文字が出ます。

約 30 秒たっても URL を確かめられないと、「サービスは適用されましたが、起動リンクをまだ
確認できません。再確認するか、サービスの詳細を開いてください。」と表示されます。デプロイは
終わっているので、少し待ってから確かめ直します。

## うまくいかないとき

| 起きること | 原因 |
| --- | --- |
| 追加はできたが、タイルが出ない | `.well-known/takosumi.json` を JSON として読めない、形が規則に合わない、`install.modules` の key が module のフォルダと合わない。どれもエラーにならず、宣言が無いものとして追加されます |
| 前は出ていたタイルが消えた | サービスの状態が **デプロイ済み** でも **更新があります** でもない（**エラー**、**無効**、**削除予定** など） |
| 追加前の確認で「このバージョンの初期設定宣言は配布元による修正が必要です。」と表示され、**今は追加できません** になる | 形は正しいが、module と合わない（`outputName` の output が無い、`sensitive` になっている）か、運用している Takosumi が許可していない利用許可を頼んでいる |
| 「サービスは適用されましたが、起動リンクをまだ確認できません。」が続く | output の値が上の URL の条件に合わない |

運用している人が manifest の版を必須にしている場合は、読めない manifest や無い manifest でも、
追加前の確認で止まります。

形は公開の JSON Schema（[v2.4](/schemas/repository-manifest-v2.4.schema.json)）で確かめられます。
ただし Takosumi の検査はこれより厳しいので、Schema に通っても追加できないことがあります。

標準の設定で頼める利用許可は、画面を開く `ui.open`（`delivery` は `none`）と、MCP を呼ぶ
`mcp.invoke`（`delivery` は `oauth2`）だけです。運用している Takosumi が設定を変えている
場合は、その範囲に従います。

## 関連

- [追加リンクを配る](./install-link.md)
- [Repository manifest](../reference/repository-manifest.md)
- [Interface](../concepts/interfaces.md)
