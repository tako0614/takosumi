# App Handoff Protocol

Takosumi App Handoff は、任意のクライアントから、その Takosumi installation が管理する
service を作成するための小さな URL プロトコルです。対象は mobile app に限らず、
web app、desktop app、ブラウザリンク、CLI 出力も含みます。

Takosumi は plain OpenTofu/Terraform source を受け取って Capsule を作成し、通常の
Takosumi フローを実行します。connection payload をクライアントへ返すのは、URL が
それを求めたときだけです。

作成には通常の Takosumi dashboard を使います。クライアントは
完了後に自分の product app または web callback URL へ戻ります。

README やウェブサイトに置く追加リンクだけが必要なら、[追加リンクを配る](../getting-started/install-link.md)
を読んでください。このページは、追加のあとに自分のクライアントへ戻す使い方を含めた protocol 全体です。

全体の流れは次のとおりです。

1. クライアントが `/install` URL を開く
2. Takosumi dashboard が開く
3. Source、Capsule、ProviderBinding、Run が順に作られる
4. StateVersion と Output が残る
5. `return_uri` があれば、そこへ戻る

## 入口の URL

外部へのエントリポイントは、operator が公開している Takosumi origin 上の次の URL です。

```text
https://<takosumi-origin>/install
```

公式 Takosumi hosted service の origin は `app.takosumi.com` です。self-host や Operator が
明示した origin でも、protocol は同じように動きます。

dashboard 内では `/new` に正規化されることがありますが、外部クライアントは
`/install` へリンクします。

対応するクエリパラメータ:

| パラメータ   | 意味                                                           |
| ------------ | -------------------------------------------------------------- |
| `git`        | plain OpenTofu/Terraform module の HTTPS Git URL               |
| `source`     | `git::<HTTPS URL>//<module のフォルダ>?ref=<ref>` 形式の packed module address（`//<フォルダ>` と `?ref=` は省略可） |
| `ref`        | Git branch / tag / commit                                      |
| `sourcePath` | sync/archive/scan する Git subtree。省略時は `.`               |
| `path`       | 追加する module のフォルダ。`sourcePath` からの相対パス。scan の結果に無ければ使わない |
| `name`       | サービス名（半角小文字、数字、ハイフン）。省略時はリポジトリ名 |
| `product`    | `return_uri` とセットで使うクライアント product key            |
| `return_uri` | `product` とセットで使う connection payload の返却先           |

何を作るかは `git` または `source` が決めます。どちらか一方を必ず付けます。残りは
任意です。Store はこの URL を事前入力するための探索・表示の入口で、作成対象や
release ref を決める権限は持ちません。`product` と `return_uri` は、完了後に
クライアントへ戻すためだけに使う組です。

`return_uri` がなければ、この URL は通常の hosted service 作成リンクとして働きます。
このときは `product` も付けません。`return_uri` があるときは、Takosumi が `product`
と `return_uri` を保持します。sign-in、ProviderConnection の設定、plan、apply と
画面が変わっても引き継ぎます。

次の 3 つは App Handoff Protocol の形ではありません。

```text
/install?=product
/install?product
/install?product=notes-app
```

いずれも OpenTofu source を指定していないため、何を作るのかが決まりません。

実際の URL は次のようになります。

```text
https://takosumi.example.com/install
  ?git=https%3A%2F%2Fgit.example.com%2Facme%2Fnotes.git
  &ref=v1.2.3
  &sourcePath=infra
  &path=deploy%2Fopentofu
  &product=notes-app
  &return_uri=notesapp%3A%2F%2Fconnect
```

## ブラウザに登録した Takosumi で開く

origin を決めない `web+takosumi:install?<上と同じクエリ>` も使えます。利用者が dashboard の
**アカウント** の **ストアからの追加先** でブラウザを登録していると、ブラウザはそのリンクを
登録した Takosumi の `/install?handoff=<リンク全体>` で開きます。

Takosumi は `handoff` の値を `web+takosumi:install` の形として読み、上の 8 つのパラメータ
だけを取り出して `/new` を開きます。`handoff` の外にあるクエリは捨てます。読めない値、
4,096 文字を超える値、知らないパラメータや重複を含む値は使わず、何も入っていない `/new` を
開きます。`web+takosumi://install` のような authority 形式は使えません。使い方は
[追加リンクを配る](../getting-started/install-link.md#開いた人の-takosumi-で開くリンク)にあります。

## OpenTofu をそのまま使う流れ

この URL が行うのは、dashboard フローの事前入力までです。作成そのものは、画面上の
明示的な操作で進みます。

1. Git URL / ref / `sourcePath` から Source を作る
2. Snapshot の tree scan で `path` を照合して Capsule を作る
3. ProviderBinding を確認する
4. plan の Run を実行する
5. 内容を確認して apply の Run を実行する
6. StateVersion と Output が残る

source リポジトリは plain OpenTofu/Terraform module のままで足ります。Takosumi 専用の
source metadata ファイルや製品固有の metadata ファイルを置く必要はありません。

`sourcePath` と `path` は `.` または正規化済みの relative directory だけを受け付けます。
未知・重複・不正なクエリフィールドが 1 つでもあるリンクは、どの値も使われず、取得元が空の
追加画面が開きます。エラーは表示されません（[リンクが使われないとき](../getting-started/install-link.md#リンクが使われないとき)）。module input は URL
では渡しません。`var.<name>` や `varjson.<name>` を付けたリンクも拒否されます。入力は Takosumi dashboard の画面で
入れます。secret、token、provider credential、private key の渡し先はさらに別で、
ProviderConnection、Credential Recipe、ProviderBinding、Secret、または製品側の
setup フローを使います。

## 戻り先へ渡す値

apply が成功すると、Takosumi は `return_uri` にクエリパラメータを追加して connect
URL を作ります。

```text
<return_uri>
  ?host_url=https%3A%2F%2Fcreated-host.example
  &product=notes-app
  &run_id=run_...
  &capsule_id=cap_...
```

製品側の setup フローが一回限りの handoff token を必要とする場合は
`setup_ticket` を追加できます。

クライアントは、返された host を次の endpoint で探索します。

```http
GET /.well-known/takosumi
GET /api/v1/capabilities
GET /openapi.json
```

製品固有の metadata が必要なクライアントは、さらに次を読みます。

```http
GET /.well-known/<product>
```

この探索を行うのはクライアント側です。Takosumi がファーストパーティの製品名を
推測して探索することはありません。

## product key と return_uri の規則

`product` は汎用の小文字キーで、次の形に一致する値だけを受け付けます。

```text
^[a-z0-9][a-z0-9._:-]{0,63}$
```

`takos` も `yurucommu` も、これから増えるアプリも、通常のクライアントとして
この field を同じように使います。

`return_uri` には次のような値を書きます。

```text
notesapp://connect
https://app.example/connect
```

条件は 3 つです。絶対 URI であること、username と password を含まないこと、query と
fragment を含まないことです。web callback は `https:` を使います。native callback は
authority 形式 (`<app-scheme>://...`) の app-owned custom scheme に限ります。
`javascript:` / `data:` / `vbscript:` / `file:` / `blob:` のように browser で
実行される scheme や、browser-local な scheme は拒否します。connect payload の
クエリは Takosumi が追加します。

拒否する scheme は `javascript:`、`data:`、`vbscript:`、`blob:`、`file:`、`about:`、
`filesystem:`、`view-source:` です。authority 形式（`javascript://…`）も同じです。connect の
リンクは dashboard の中で anchor として表示されるため、これらは移動ではなく dashboard の
origin でのスクリプト実行になります。

## 責任境界

Takosumi 側は、この protocol と dashboard のフローを持ちます。Source / Capsule /
Run の lifecycle、state と output と audit、ProviderConnection の確認、capability
discovery も Takosumi 側です。

クライアント側は、product UI と、custom scheme や web callback の受け取りを持ちます。
native plugin、push notification の登録、通話の処理、connect 後に製品 API を呼ぶ
ところもクライアント側です。

push notification の配信は、クライアントと製品側の host が担当します。connect 後に
製品側の device token を自分の host API へ送れますが、Takosumi は push capability を
公開しません。
