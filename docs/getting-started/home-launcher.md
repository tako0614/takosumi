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

Takosumi は宣言を検査し、アプリの画面の API（`GET /api/v1/capsules/{id}/app` の
`screens[].clients`）で返します。スマホのブラウザの dashboard は、これを使って画面の開き方を決めます
（下の[スマホでの開き方](#スマホでの開き方)）。Takosumi Mobile が専用アプリへ渡す動作は、これから入ります。

```json
"document": {
  "launcher": true,
  "display": { "title": "Yurucommu", "icon": "/icon.svg" },
  "clients": {
    "preferred": "native",
    "ios": {
      "bundleId": "com.yurucommu",
      "open": "yurucommu://connect?host_url={origin}&product=yurucommu"
    },
    "android": {
      "package": "com.yurucommu",
      "open": "yurucommu://connect?host_url={origin}&product=yurucommu"
    }
  }
}
```

| 欄 | 書くもの |
| --- | --- |
| `preferred` | スマホで開くときの既定。`"native"`（専用アプリ）か `"web"`。省くと `"native"`。ただし API が `"native"` を返すのは、どれかの OS の専用アプリが検証済み（下）のときだけで、それ以外は `"web"` を返します。効くのも、検証済みの専用アプリがある OS だけです |
| `ios.bundleId` | bundle id（`com.example.notes` のような逆 DNS の形）。検証には必須 |
| `android.package` | 必須。applicationId（逆 DNS の形）。Android ではこの package のアプリにだけ渡します |
| `open` | 専用アプリの custom scheme の link の雛形 |
| `ios.universalLink`・`android.appLink` | 任意。配布者のドメインに置いた https の link（universal link・App Links）の雛形 |
| `ios.name`・`android.name` | 任意。未検証のときに選ぶ画面に出す名前（64 文字まで。アクセントを外す（NFKD）と ASCII になる名前か、英字を含まない日本語の名前）。検証済みなら、運用している人が登録した名前を使います |
| `ios.appStoreId` | 任意。App Store の ID（1〜12 桁の数字）。検証済みなら、登録された ID を使います |
| `ios.storeUrl`・`android.storeUrl` | 任意。入れる先の link。宣言した ID に結び付いたものだけ使えます（下） |

### 検証済みと未検証

どのアプリも、どんな宣言でも書けます。宣言だけでは、それが本当にその product の専用アプリかは
分かりません。そこで Takosumi は、運用している人が信頼すると登録した専用アプリ（下の
`TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS`）と照らします。

- **検証済み**（`verified: true`）: 宣言した `bundleId`（Android は `package`）が登録と一致し、
  link の雛形も登録された雛形のどれかと一致するもの。名前、App Store の ID は登録の値を使い、宣言の
  値は使いません。一致しない link は捨てます。登録された `bundleId`・`package` を名乗りながら、
  一致する link が一つも無い宣言は、その OS ごと捨てます。
- **未検証**（`verified: false`）: それ以外の宣言。実際の行き先（Android の package、custom scheme、
  link の host）を `target` に入れて返します。登録された専用アプリが持つ scheme と host、その host の
  下の host（`evil.open.example.com` など）は使えません。名前は、Takosumi や登録された専用アプリに
  似せたもの（大文字小文字、全角、`0` と `o` のような似た文字の違いを含む）を捨てます。日本語の名前は、
  カタカナをひらがなに、小さいかなを大きいかなにそろえ、空白・中黒・長音記号を除いて比べ、登録された
  名前と同じか、それを含むか、その一部（2 文字以上）なら捨てます（`ゆるこみゅ` が登録されていれば
  `ユルコミュ`・`ゆるこみゅ公式` も捨てます）。`たこすみ`・`タコスミ` も Takosumi の名前として捨てます。
  さらに、アクセントを外す（NFKD）と ASCII になる名前でも、英字を含まない日本語の名前でもないもの
  （キリル文字・ギリシャ文字・チェロキー文字などのほかの文字、`ß`・`Ø`・`Ł`・`Æ` のように分解できない
  文字、`©` などの記号、小さな大文字、絵文字、英字とかな・漢字の混在）と、一つの文字にまとまらない
  結合文字（文字に重ねる線、重ねたアクセントなど。かなの濁点・半濁点はまとまるので使えます）を
  含む名前を捨てます。

dashboard と Takosumi Mobile は、検証済みの専用アプリだけを尋ねずに開き、`preferred: "native"` も
検証済みのときだけ効かせます。未検証の専用アプリは自動では開かず、開く前に `target` を見せて確かめます。
未検証の専用アプリに `name` が無いときは「未確認のアプリ」のような中立の表示と `target` を出し、
画面の `display.title` は使いません（title は登録された名前に似ていないかを確かめていないため）。

雛形の比較では、scheme と host の大文字小文字と既定の port（`:443`）だけをそろえ、ほかは文字どおりに
比べます。登録された雛形には、必ず `{origin}` が入っています。

標準では、TASK-0119 の設計にある三つの専用アプリを信頼します。

| id | 名前 | bundle id・package | 雛形（iOS・Android 共通） |
| --- | --- | --- | --- |
| `yurucommu-mobile` | Yurucommu | `com.yurucommu` | `yurucommu://connect?host_url={origin}`、`yurucommu://connect?host_url={origin}&product=yurucommu` |
| `yurumeet-mobile` | Yurumeet | `com.yurumeet` | `yurume://connect?host_url={origin}`、`yurume://connect?host_url={origin}&product=yurumeet` |
| `takos-mobile` | Takos | `jp.takos.mobile` | `takos://connect?host_url={origin}`、`takos://connect?host_url={origin}&product=takos` |

運用している人は、`TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS` に JSON の配列を設定して、この一覧を
置き換えられます（`[]` なら、どれも信頼しません）。書き方は
[設定](../reference/configuration.md)にあります。

### スマホでの開き方

パソコンの dashboard では、今までどおり画面を新しいタブで開きます。スマホのブラウザでは、ホームの
タイルとアプリのページの **開く** が、次の順に開き方を決めます。

1. この端末で覚えた選択（アプリのページの **スマホで使う** で **この端末で覚える** にチェックしてから
   選んだもの）。
2. 宣言の `preferred: "native"`。その OS の専用アプリが検証済みのときだけ効きます。
3. それ以外は web（ブラウザ）。

- Android: dashboard が `intent:` の link を組み立て、届く先を宣言の `package` に固定します。専用アプリが
  入っていなければ、Chrome がアプリのページの選ぶ画面（`/apps/{id}?open=<画面>&missing=1#phone`）へ
  戻します。宣言に `intent:` は書けません。
- iPhone・iPad: `universalLink` は、利用者が押す普通の link にします。`open`（custom scheme）しか無いと、
  入っていないときに Safari がエラーを出すので、選ぶ画面で **{name}で開く** を選んで覚えるまでは、
  **開く** は選ぶ画面へ進みます。Smart App Banner は使いません。
- 未検証の専用アプリは、押しただけでは開きません。選ぶ画面に `target`（package、scheme、link の
  ドメイン）とストアの行き先を出し、確かめてから開きます。覚えることもしません。
- 覚えた選択は、そのブラウザの `localStorage` に（アプリ、画面）ごとに置き、サーバーには送りません。
  保存できないブラウザでは、毎回既定の開き方で開きます。アプリのページの **開き方を変える** から、
  選び直しと削除ができます。
- 専用アプリへ渡る値は、雛形に入れた画面の URL か origin だけです。

### 雛形と link

- 各 OS に、`open` か `universalLink`（Android は `appLink`）の少なくとも一つが要ります。Android は
  `package` も要ります。
- 雛形に入れられるのは `{origin}`（画面の URL の origin）と `{url}`（画面の URL 全体）だけで、
  合わせて 4 個までです。どちらも URL encode して入れます。専用アプリへ渡るのはこの公開の URL だけで、
  token、session、アカウントの ID は入りません。今の yurucommu-mobile などは `connect?host_url=` を
  読むので、`open` はこの例の形で使えます。
- 各 instance のドメインは利用者ごとに違うので、専用アプリが instance のドメインを universal link
  として持つことはできません。universal link・App Links を使うなら、配布者のドメインにページを置き、
  アプリが無いときはそこからストアと web へ案内します。instance の URL を `#` の後に置けば、
  そのページのサーバーへは送られません。
- `storeUrl` は、iOS は `appStoreId` の App Store のページ（`apps.apple.com` の `id<appStoreId>`）、
  Android は `package` の Google Play（`details?id=<package>`）か F-Droid（`/packages/<package>/`）の
  ページだけです。TestFlight の `join` の link は、登録で `testFlight: true` にした検証済みの専用アプリ
  だけが使えます。無ければ、`appStoreId` か `package` から作ります。
- `clients` は `document` の中の任意の欄なので、Interface の版（`"1"`）も manifest の版も変わりません。
  知らない Takosumi はこの欄を無視します。

### 通らない値

検査に通らない値はエラーにならず、その欄が無かったことになります。OS で開く手段が無くなれば、
その OS ごと無かったことになります。知らない欄と OS（`windows` など）は無視し、API にも出しません。
宣言に `verified` や `trustedClientId` を書いても、無視します。

| 欄 | 通らないもの |
| --- | --- |
| `open` | scheme が英小文字で始まる 2〜32 文字（英小文字・数字・`+`・`.`・`-`）でないもの、下の禁止の scheme、ユーザー名やパスワード、`token` のような認証情報らしい名前の query、`#` 以降（Android では Takosumi が `intent:` の link を組み立てて後ろに付けるため） |
| `universalLink`・`appLink` | `https://` 以外（`http://` を含む）、ユーザー名やパスワード、443 以外の port、IP アドレスや `.` の無い host、認証情報らしい名前の query や `#` 以降の値、Takosumi のドメイン（`takosumi.com` とその下、その Takosumi の dashboard と issuer の host）、未検証のときは登録された専用アプリの host とその下 |
| 雛形の全体 | `{origin}`・`{url}` 以外の `{...}`（`{ORIGIN}`、対になっていない `{` も）、5 個以上の placeholder、host の部分に置いた `{origin}`・`{url}`、空白や URL に使えない文字、値を入れる前か後で 2,048 文字を超えるもの |
| `bundleId`・`android.package` | 逆 DNS の形でないもの（155 文字まで）、Takosumi Mobile 自身の `com.takosumi` とその下（この場合は OS ごと捨てます） |
| `appStoreId` | 1〜12 桁の数字でないもの |
| `storeUrl` | 宣言した ID と違うアプリのページ、上の決まったドメイン以外 |
| `name` | 65 文字以上、制御文字・書式文字（文字の向きを変える文字、幅の無い文字など）・行や段落の区切り、Takosumi や登録された専用アプリに似せた名前（かなでも）、NFKD で ASCII にならず英字を含まない日本語でもない名前、まとまらない結合文字を含む名前（上） |

`open` で使えない scheme: `http`、`https`（`universalLink`・`appLink` に書きます）、`javascript`、
`vbscript`、`data`、`file`、`filesystem`、`blob`、`about`、`content`、`intent`、`android-app`
（Android の link は Takosumi が組み立てます）、`takosumi`（Takosumi Mobile 自身）、`tel`、`callto`、
`sms`、`smsto`、`mms`、`mmsto`、`mailto`、`facetime`、`facetime-audio`、`facetime-prompt`、
`facetime-audio-prompt`、`itms`、`itmss`、`itms-apps`、`itms-appss`、`itms-services`、`itms-beta`、
`market`、`app-settings`、`app-prefs`、`prefs`、`shortcuts`、`x-web-search`、`ws`、`wss`、`ftp`、
任意の web ページを開くブラウザのアプリ（`x-safari-http`、`x-safari-https`、`googlechrome`、
`googlechromes`、`googlechrome-x-callback`、`firefox`、`firefox-focus`、`focus`、`microsoft-edge`、
`microsoft-edge-http`、`microsoft-edge-https`、`opera`、`opera-http`、`opera-https`、`touch-http`、
`touch-https`、`brave`、`duckduckgo`、`ddgquicklink`、`samsunginternet`、`yandexbrowser-open-url`、
`firefox-klar`、`onionhttp`、`onionhttps`）。
この一覧は最悪の scheme を落とすだけで、信頼は上の登録で決まります。

Takosumi 自身の識別子（Takosumi Mobile の bundle id・package・scheme、Takosumi のドメイン、予約した名前）は、
公開の package の `@takosjp/takosumi-contract/native-client-identity` にあり、Takosumi Mobile も同じ値を使います。

## 追加した人に見えるもの

1. 追加の最後に「サービスを準備しています」と表示され、画面の URL が使えるようになるのを
   待ちます。
2. **追加できました** の画面の **サービスを開く** で、画面が新しいタブで開きます。
3. ホームの **あなたのアプリ** に、アイコンと `display.title`（無ければサービス名）のタイルが
   出ます。押すと画面が新しいタブで開きます（スマホでは[スマホでの開き方](#スマホでの開き方)のとおり）。
   アイコンが無いときは名前の頭文字が出ます。
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
