# ホームにアプリを出す

自分のソフトウェアに、使う人が開く画面（web アプリ）があるなら、dashboard のホーム
（**あなたのアプリ**）にそれを開くタイルを出せます。追加が終わった画面の **サービスを開く** も、
その画面を新しいタブで開くようになります。宣言は、リポジトリの `.well-known/takosumi.json`
（[Repository manifest](../reference/repository-manifest.md)）に書きます。

宣言が無いアプリもホームにタイルとして並びますが、押すと画面ではなくアプリのページが開きます。

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
部分です。ホームのタイルが画面を開くのは、この利用許可を持つ人だけです。インストールが
終わっていないアプリと、アンインストール予定や停止中のアプリのタイルは少し薄く表示されます。
小さな印（**インストール中**、**要対応** など）が付き、押すとアプリのページが開きます。

## スマホの専用アプリを宣言する

同じ product にスマホの専用アプリ（App Store や Google Play で配布するネイティブアプリ）があるなら、
`document` の `display` と並べて `clients` に書けます。Takosumi はこれを読み、スマホでは画面を
専用アプリへ渡せるようにします。書かなくても、web で開くことはいつでもできます。

今の Takosumi が行うのは、宣言の検査と、アプリの画面の API（`GET /api/v1/capsules/{id}/app` の
`screens[].clients`）で返すところまでです。dashboard と Takosumi Mobile が専用アプリへ渡す動作は、
これから入ります。

```json
"document": {
  "launcher": true,
  "display": { "title": "Notes", "icon": "/icon.svg" },
  "clients": {
    "preferred": "native",
    "ios": {
      "name": "Notes",
      "appStoreId": "1234567890",
      "open": "notes://connect?host_url={origin}",
      "universalLink": "https://open.notes.example/connect#host_url={origin}"
    },
    "android": {
      "name": "Notes",
      "package": "com.example.notes",
      "open": "notes://connect?host_url={origin}",
      "appLink": "https://open.notes.example/connect#host_url={origin}"
    }
  }
}
```

ストアの ID とドメインは例です。

| 欄 | 書くもの |
| --- | --- |
| `preferred` | スマホで開くときの既定。`"native"`（専用アプリ）か `"web"`。省くと `"native"` で、専用アプリを宣言した OS で効きます |
| `ios.name`・`android.name` | 選ぶ画面に出す専用アプリの名前（64 文字まで）。省くと画面の名前（`display.title`）を使います |
| `ios.appStoreId` | App Store の ID（1〜12 桁の数字）。入れる先を `https://apps.apple.com/app/id<ID>` にします |
| `ios.bundleId` | 任意。bundle id（`com.example.notes` のような逆 DNS の形） |
| `android.package` | 必須。applicationId（逆 DNS の形）。Android ではこの package のアプリにだけ渡し、入れる先をその Google Play のページにします |
| `open` | 専用アプリの custom scheme の link の雛形 |
| `ios.universalLink`・`android.appLink` | 任意。配布者のドメインに置いた https の link（universal link・App Links）の雛形 |
| `ios.storeUrl`・`android.storeUrl` | 任意。入れる先を変えるとき（TestFlight、F-Droid など）。iOS は `apps.apple.com`・`testflight.apple.com`、Android は `play.google.com`・`f-droid.org` の https だけ |

- 各 OS に、`open` か `universalLink`（Android は `appLink`）の少なくとも一つが要ります。Android は
  `package` も要ります。
- 雛形に入れられるのは `{origin}`（画面の URL の origin）と `{url}`（画面の URL 全体）だけです。
  どちらも URL encode して入れます。専用アプリへ渡るのはこの公開の URL だけで、token、session、
  アカウントの ID は入りません。今の yurucommu-mobile などは `connect?host_url=` を読むので、
  `open` はこの例の形で使えます。
- 各 instance のドメインは利用者ごとに違うので、専用アプリが instance のドメインを universal link
  として持つことはできません。universal link・App Links を使うなら、配布者のドメインにページを置き、
  アプリが無いときはそこからストアと web へ案内します。instance の URL を `#` の後に置けば、
  そのページのサーバーへは送られません。
- `clients` は `document` の中の任意の欄なので、Interface の版（`"1"`）も manifest の版も変わりません。
  知らない Takosumi はこの欄を無視します。

検査に通らない値はエラーにならず、その欄が無かったことになります。OS で開く手段が無くなれば、
その OS ごと無かったことになります。知らない欄と OS（`windows` など）は無視し、API にも出しません。

| 欄 | 通らないもの |
| --- | --- |
| `open` | scheme が英小文字で始まる 2〜32 文字（英小文字・数字・`+`・`.`・`-`）でないもの、下の禁止の scheme、ユーザー名やパスワード、`token` のような認証情報らしい名前の query、`#` 以降（Android では Takosumi が `intent:` の link を組み立てて後ろに付けるため） |
| `universalLink`・`appLink` | `https://` 以外（`http://` を含む）、ユーザー名やパスワード、443 以外の port、IP アドレスや `.` の無い host、認証情報らしい名前の query や `#` 以降の値、Takosumi 自身の origin |
| 雛形の全体 | `{origin}`・`{url}` 以外の `{...}`（`{ORIGIN}`、対になっていない `{` も）、host の部分に置いた `{origin}`・`{url}`、空白や URL に使えない文字、値を入れる前か後で 2,048 文字を超えるもの |
| `appStoreId`・`bundleId`・`android.package` | 1〜12 桁の数字でない ID、逆 DNS の形でない名前（155 文字まで） |
| `name` | 65 文字以上、制御文字や文字の向きを変える文字を含むもの |

`open` で使えない scheme: `http`、`https`（`universalLink`・`appLink` に書きます）、`javascript`、
`vbscript`、`data`、`file`、`filesystem`、`blob`、`about`、`content`、`intent`、`android-app`
（Android の link は Takosumi が組み立てます）、`takosumi`（Takosumi Mobile 自身）、`tel`、`callto`、
`sms`、`smsto`、`mms`、`mmsto`、`mailto`、`facetime`、`facetime-audio`、`facetime-prompt`、
`facetime-audio-prompt`、`itms`、`itmss`、`itms-apps`、`itms-appss`、`itms-services`、`itms-beta`、
`market`、`app-settings`、`app-prefs`、`prefs`、`shortcuts`、`ws`、`wss`、`ftp`。

## 追加した人に見えるもの

1. 追加の最後に「サービスを準備しています」と表示され、画面の URL が使えるようになるのを
   待ちます。
2. **追加できました** の画面の **サービスを開く** で、画面が新しいタブで開きます。
3. ホームの **あなたのアプリ** に、アイコンと `display.title`（無ければサービス名）のタイルが
   出ます。押すと画面が新しいタブで開きます。アイコンが無いときは名前の頭文字が出ます。
   タイルの下の **管理** で、アプリのページが開きます。

約 30 秒たっても URL を確かめられないと、「サービスは適用されましたが、起動リンクをまだ
確認できません。再確認するか、サービスの詳細を開いてください。」と表示されます。デプロイは
終わっているので、少し待ってから確かめ直します。

## うまくいかないとき

| 起きること | 原因 |
| --- | --- |
| タイルを押すと、画面ではなくアプリのページが開く | `.well-known/takosumi.json` を JSON として読めない、形が規則に合わない、`install.modules` の key が module のフォルダと合わない。どれもエラーにならず、宣言が無いものとして追加されます |
| 前は画面が開いたタイルが薄くなり、アプリのページが開く | アプリが更新中、アンインストール予定、停止中のどれかです。タイルの印で分かります |
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
