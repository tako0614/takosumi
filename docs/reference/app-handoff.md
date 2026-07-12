# App Handoff Protocol

Takosumi App Handoff は、任意のクライアントから Takosumi が管理する hosted
service を作成するための小さな URL プロトコルです。対象は mobile app に限らず、
web app、desktop app、ブラウザリンク、CLI 出力も含みます。

Host Center は web / dashboard のフローです。このプロトコルは単独の
Takosumi mobile app を要求せず、示唆もしません。クライアントは自分の product app または
web callback URL に戻ります。

これは製品レジストリではありません。Takosumi は plain OpenTofu/Terraform
source を受け取り、Capsule を作成し、通常の Takosumi フローを実行し、必要な場合だけ
connection payload をクライアントに返します。

```text
client
  -> /install URL
  -> Takosumi Host Center
  -> Source / Capsule / ProviderBinding / Run
  -> StateVersion / Output
  -> optional return_uri
```

## Entry URL

外部公開のエントリポイントはこれです。

```text
https://app.takosumi.com/install
```

dashboard 内では `/new` に正規化されることがありますが、外部クライアントは
`/install` へリンクします。

対応するクエリパラメータ:

| Parameter         | Required | 意味                                               |
| ----------------- | -------- | -------------------------------------------------- |
| `git`             | no       | plain OpenTofu/Terraform module の HTTPS Git URL     |
| `source`          | no       | `git::...?...` 形式の packed module address          |
| `ref`             | no       | Git branch / tag / commit                            |
| `path`            | no       | リポジトリ内の module path                           |
| `name`            | no       | サービスの表示名                                     |
| `var.<name>`      | no       | secret ではない可視の module input                   |
| `product`         | no       | `return_uri` とセットで使うクライアント product key  |
| `return_uri`      | no       | `product` とセットで使う connection payload の返却先 |

`git` または `source` が作成対象を指定します。Store はこの URL を事前入力
するための探索・表示の入口であり、作成対象や release ref の権限ではありません。
`product` は作成対象ではありません。`product` と `return_uri` はクライアントへ
戻すときだけセットで使います。

`return_uri` がない場合、この URL は通常の hosted-service 作成リンクです。この場合
`product` も付けません。`return_uri` がある場合、Takosumi は `product` と
`return_uri` を sign-in、provider connection setup、plan、apply の画面遷移をまたいで
保持します。

存在しない形:

```text
/install?=product
/install?product
/install?product=notes-app
```

これらは OpenTofu source を指定せず、何を作るかが決まらないため App Handoff
Protocol には該当しません。

例:

```text
https://app.takosumi.com/install
  ?git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git
  &ref=v1.2.3
  &path=deploy%2Fopentofu
  &product=notes-app
  &return_uri=notesapp%3A%2F%2Fconnect
```

## OpenTofu-Native Flow

URL 自体は install を実行しません。明示的な dashboard フローを事前入力するだけです。

```text
Git URL / ref / path
  -> Source
  -> Capsule
  -> ProviderBinding review
  -> Run(plan)
  -> Run(apply)
  -> StateVersion / Output
```

source リポジトリは plain OpenTofu/Terraform module のままです。Takosumi 専用の
source metadata ファイルや製品固有の metadata ファイルは要求しません。

`var.<name>` は secret ではない可視の入力専用です。secret、token、provider
credential、private key は Provider Connection、Credential Recipe、Provider Binding、
Secret、または製品側の setup フローから渡します。

## Return Payload

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

クライアントは返された host を次の endpoint で探索します。

```text
GET /.well-known/takosumi
GET /v1/capabilities
```

製品固有の metadata が必要なクライアントだけ、追加でこれを読みます。

```text
GET /.well-known/<product>
```

Takosumi はファーストパーティの製品名を自動探索しません。

## Product Key And Return URI Rules

`product` は汎用の小文字キーです。

```text
^[a-z0-9][a-z0-9._:-]{0,63}$
```

Takosumi の列挙型ではありません。`takos`、`yurucommu`、将来のアプリはすべて同じ
field を通常のクライアントとして使います。

`return_uri` は次の形を使えます。

```text
notesapp://connect
https://app.example/connect
```

絶対 URI であること、username/password を含まないこと、既存の query / fragment を
含まないことが条件です。Takosumi が connect payload を追加します。

## 責任境界

Takosumi が持つもの:

```text
protocol
Host Center flow
Source / Capsule / Run lifecycle
state / output / audit
provider connection review
capability discovery
```

クライアントが持つもの:

```text
product UI
custom scheme handling
web callback handling
native plugins
push notification registration
call handling
post-connect product API calls
```

push notification の配信は Takosumi Resource Shape でも provider でもありません。
クライアントは connect 後に製品側の device token を自分の host API へ送れますが、
Takosumi は push capability を公開しません。
