# App Handoff Protocol

Takosumi App Handoff は、任意のクライアントから、その Takosumi installation が管理する
service を作成するための小さな URL プロトコルです。対象は mobile app に限らず、
web app、desktop app、ブラウザリンク、CLI 出力も含みます。

Takosumi は plain OpenTofu/Terraform source を受け取って Capsule を作成し、通常の
Takosumi フローを実行します。connection payload をクライアントへ返すのは、URL が
それを求めたときだけです。

作成には通常の Takosumi dashboard を使います。クライアントは
完了後に自分の product app または web callback URL へ戻ります。

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

公式 Takosumi Cloud の origin は `app.takosumi.com` です。self-host や Operator が
明示した origin でも、protocol は同じように動きます。

dashboard 内では `/new` に正規化されることがありますが、外部クライアントは
`/install` へリンクします。

対応するクエリパラメータ:

| パラメータ   | 意味                                                 |
| ------------ | ---------------------------------------------------- |
| `git`        | plain OpenTofu/Terraform module の HTTPS Git URL     |
| `source`     | `git::...?...` 形式の packed module address          |
| `ref`        | Git branch / tag / commit                            |
| `path`       | リポジトリ内の module path                           |
| `name`       | サービスの表示名                                     |
| `product`    | `return_uri` とセットで使うクライアント product key  |
| `return_uri` | `product` とセットで使う connection payload の返却先 |

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
  &path=deploy%2Fopentofu
  &product=notes-app
  &return_uri=notesapp%3A%2F%2Fconnect
```

## OpenTofu をそのまま使う流れ

この URL が行うのは、dashboard フローの事前入力までです。作成そのものは、画面上の
明示的な操作で進みます。

1. Git URL / ref / path から Source を作る
2. Source から Capsule を作る
3. ProviderBinding を確認する
4. plan の Run を実行する
5. 内容を確認して apply の Run を実行する
6. StateVersion と Output が残る

source リポジトリは plain OpenTofu/Terraform module のままで足ります。Takosumi 専用の
source metadata ファイルや製品固有の metadata ファイルを置く必要はありません。

module input は URL では渡しません。`var.<name>` や `varjson.<name>` を付けた
リンクを開いても、その値は読み捨てられます。入力は Takosumi dashboard の画面で
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
GET /v1/capabilities
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
