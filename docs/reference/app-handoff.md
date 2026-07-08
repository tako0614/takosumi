# App Handoff Protocol

Takosumi App Handoff は、任意の client から Takosumi-managed な hosted
service を作成するための小さな URL protocol です。対象は mobile app に限らず、
web app、desktop app、browser link、CLI output も含みます。

Host Center は web / dashboard flow です。この protocol は standalone の
Takosumi mobile app を要求せず、示唆もしません。client は自分の product app または
web callback URL に戻ります。

これは product registry ではありません。Takosumi は plain OpenTofu/Terraform
source を受け取り、Capsule を作成し、通常の Takosumi flow を実行し、必要な場合だけ
connection payload を client に返します。

```text
client
  -> /install URL
  -> Takosumi Host Center
  -> Source / Capsule / ProviderBinding / Run
  -> StateVersion / Output
  -> optional return_uri
```

## Entry URL

外部公開 entrypoint はこれです。

```text
https://app.takosumi.com/install
```

dashboard 内では `/new` に canonicalize されることがありますが、外部 client は
`/install` へ link します。

対応する query parameters:

| Parameter         | Required | 意味                                               |
| ----------------- | -------- | -------------------------------------------------- |
| `git`             | no       | plain OpenTofu/Terraform module の HTTPS Git URL   |
| `source`          | no       | `git::...?...` 形式の packed module address        |
| `ref`             | no       | Git branch / tag / commit                          |
| `path`            | no       | repository 内の module path                        |
| `name`            | no       | service の表示名                                   |
| `var.<name>`      | no       | secret ではない visible module input               |
| `product`         | no       | `return_uri` とセットで使う client product key     |
| `return_uri`      | no       | `product` とセットで使う connection payload 返却先 |

`git` または `source` が作成対象を指定します。Store はこの URL を prefill
するための discovery / presentation 入口であり、作成対象や release ref の
authority ではありません。`product` は作成対象ではありません。`product` と
`return_uri` は client へ戻すときだけセットで使います。

`return_uri` がない場合、この URL は通常の hosted-service 作成 link です。この場合
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
Protocol ではありません。

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

URL 自体は install を実行しません。明示的な dashboard flow を prefill するだけです。

```text
Git URL / ref / path
  -> Source
  -> Capsule
  -> ProviderBinding review
  -> Run(plan)
  -> Run(apply)
  -> StateVersion / Output
```

source repository は plain OpenTofu/Terraform module のままです。Takosumi 専用
source metadata file や product-specific metadata file は要求しません。

`var.<name>` は secret ではない visible input 専用です。secret、token、provider
credential、private key は Provider Connection、Credential Recipe、Provider Binding、
Secret、または product-owned setup flow から渡します。

## Return Payload

apply が成功すると、Takosumi は `return_uri` に query parameter を追加して connect
URL を作ります。

```text
<return_uri>
  ?host_url=https%3A%2F%2Fcreated-host.example
  &product=notes-app
  &run_id=run_...
  &capsule_id=cap_...
```

product-owned setup flow が一回限りの handoff token を必要とする場合は
`setup_ticket` を追加できます。

client は返された host を次の endpoint で discover します。

```text
GET /.well-known/takosumi
GET /v1/capabilities
```

product 固有 metadata が必要な client だけ、追加でこれを読みます。

```text
GET /.well-known/<product>
```

Takosumi は first-party product 名を probe しません。

## Product Key And Return URI Rules

`product` は generic な lower-case key です。

```text
^[a-z0-9][a-z0-9._:-]{0,63}$
```

Takosumi enum ではありません。`takos`、`yurucommu`、将来の app はすべて同じ
field を普通の client として使います。

`return_uri` は次の形を使えます。

```text
notesapp://connect
https://app.example/connect
```

absolute URI であること、username/password を含まないこと、既存 query / fragment を
含まないことが条件です。Takosumi が connect payload を追加します。

## Boundary

Takosumi が持つもの:

```text
protocol
Host Center flow
Source / Capsule / Run lifecycle
state / output / audit
provider connection review
capability discovery
```

client が持つもの:

```text
product UI
custom scheme handling
web callback handling
native plugins
push notification registration
call handling
post-connect product API calls
```

push notification delivery は Takosumi Resource Shape でも provider でもありません。
client は connect 後に product-owned device token を自分の host API へ送れますが、
Takosumi は push capability を広告しません。
