# 追加できるリポジトリを用意する

Takosumi に追加できるのは、Git に置いた OpenTofu の root module です。Takosumi 専用の
設定ファイルは要りません。このページは、自分のソフトウェアを Takosumi から追加できる
ようにするときに守ることをまとめます。

追加の途中で、Takosumi はリポジトリを調べます。問題があると、追加の画面に
**手直しが必要です** か **今は追加できません** と表示され、先に進めません。どちらの場合も、
リポジトリを直して新しい commit を追加し直します。

## 最小の形

```text
deploy/opentofu/
  main.tf        # resource と provider の宣言
  variables.tf   # 利用者が入れる値（任意）
  outputs.tf     # 少なくとも 1 つの output
```

```hcl
# examples/opentofu-null-provider/main.tf から抜粋（1 つのファイルにまとめても構いません）
terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

variable "name" {
  type    = string
  default = "takosumi-null-provider"
}

resource "null_resource" "marker" {
  triggers = {
    name = var.name
  }
}

output "example_label" {
  value = null_resource.marker.triggers.name
}
```

- 設定ファイルは `.tf` か `.tofu` で書きます。`.tf.json` は今は追加できません。
- Git で追跡しているファイルだけが読まれます。
- `output` を少なくとも 1 つ置きます。1 つも無いと追加できません。
- provider は `required_providers` に宣言します。`source` を省くと `hashicorp/<名前>` と
  みなされるため、`hashicorp/` 以外の provider には `cloudflare/cloudflare` のように
  `source` を必ず書きます。
- provider block に認証情報を書きません。`token`、`api_token`、`api_key`、`access_key`、
  `secret_key`、`client_secret`、`password` という名前の属性は、変数から渡す場合も
  止められます。ほかの名前は調べられませんが、同じく書かないでください。認証情報は、実行の
  ときに接続（Connection）から環境変数かファイルで渡ります（[認証情報](../concepts/credentials.md)）。
- 動く例は [`examples/opentofu-basic`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-basic)
  （provider なし）と
  [`examples/opentofu-null-provider`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-null-provider)
  （provider を 1 つ使う最小の例）です。

## 追加できなくなるもの

Takosumi が読む範囲は、既定ではリポジトリ全体です。追加リンクの `path` は追加する module の
ディレクトリ、`sourcePath`（Source の `defaultPath`）は読む範囲です
（[Source と Capsule](../concepts/sources.md)）。

### 読む範囲の module がすべて止まるもの

次のどれかが読む範囲のどこかに 1 つでもあると、その範囲のどの module も追加できません。
テスト用や例の module が同じリポジトリにあるときは、`sourcePath` で読む範囲を本体の module の
ディレクトリに絞ります。

| 書いたもの | 直し方 |
| --- | --- |
| registry や `git::` など、リモートの module source | 使う module をリポジトリに入れ、`./` から始まるパスで参照します。バージョンを固定していてもリモートは使えません |
| 選んだ module のディレクトリの外を指す `../` の module source | 必要な module を、選ぶ module のディレクトリの中に置きます |
| 文字列そのままでない module source、存在しないディレクトリを指す module source | `source` は `"./modules/app"` のような文字列で書き、そのディレクトリを commit します |
| 同じ provider への、食い違う固定バージョン | どの module でも同じバージョンを指定します |
| 読めない JSON の設定ファイル、上限を超える数や大きさ | 直すか、読む範囲を絞ります（下の「大きさの上限」） |

### その module だけが止まるもの

| 書いたもの | 直し方 |
| --- | --- |
| `.tf.json` の設定ファイル | 同じ内容を HCL（`.tf`）で書きます |
| resource があるのに `required_providers` が無い | `required_providers` に provider を宣言します |
| provisioner（`local-exec`、`remote-exec`、`file`） | 削除します。運用している人が許可した場合だけ使えます |
| `external` data source | 削除します。運用している人が許可した場合だけ使えます |
| 運用している人が許可していない provider、resource、data source | 許可されているものに変えるか、運用している人に相談します |
| `path.root`、`abspath()`、`pathexpand()` | 使わずに、module の中のファイルか変数で渡します。コメントに書いただけでも止まります |
| `file()` や `templatefile()` などに渡す、`/` や `~` から始まる文字列のパスや、`..` を含む文字列のパス | module の中のファイルを相対パスで読むか、変数で渡します |
| `ephemeral` な root output、`sensitive` に `true`/`false` 以外の式 | `sensitive` と `ephemeral` は `true` か `false` をそのまま書きます |
| 同じ root の変数を 2 回宣言している、override ファイルにしかない変数 | 変数は 1 回だけ宣言し、override ファイルでは宣言済みの変数だけを変えます |
| commit した `.terraform.lock.hcl` の provider が、module の provider と合わない | lock を消すか、`tofu init` で作り直して commit します |

追跡している symbolic link や Git submodule があると、追加の画面より前の、リポジトリの取得の
段階で失敗します。実体のファイルとしてリポジトリに入れます。

## 変数と output

- `default` の無い変数は、追加するときに入力が必須になります。`default = null` は任意です。
- `string`、`number`、`bool` はそのまま入力し、`list`、`map`、`object` など、`type` の無い
  変数も含めて、それ以外は JSON の値として入れます。
- 変数の `sensitive = true` は、入力を秘密として扱う指定になりません。秘密の入力は
  [Repository manifest](../reference/repository-manifest.md) の `inputs[].secret` で指定します。
- `sensitive` でない output は、名前にかかわらず Workspace に記録されます（128 個、1 個 64 KiB、
  合計 256 KiB まで。超えた分は記録されません）。
- Workspace の外に公開されるのは、明示的に対応付けた output だけです。対応付けても、名前に
  `token`、`secret`、`password`、`key`、`auth`、`session` などを `_` や `-` で区切って含むもの
  （例: `public_key`、`auth_url`）や、値が秘密に見えるものは公開されません
  （[状態と出力](../concepts/state-and-outputs.md)）。

## 無くてもよいもの

- `.well-known/takosumi.json`（[Repository manifest](../reference/repository-manifest.md)）
  は任意です。入力欄の説明、秘密の入力、Interface などを足したいときだけ置きます。
- `.terraform.lock.hcl` は任意です。無ければ確認のときに作られ、変更の確認（plan）で固定
  されます。置く場合は、OpenTofu（`tofu init`）が作り、module の provider と合っているものを
  commit します。

## 大きさの上限

| 対象 | 上限 |
| --- | --- |
| 設定ファイル | 256 個、1 個 1 MiB、合計 4 MiB |
| 見つかる root module | 32 個 |
| パスの深さ | ファイル名を含めて 64 段まで |
| 取得するリポジトリの範囲（archive） | 既定 50 MiB（運用している人が変えられます） |

## OpenTofu のバージョン

標準の runner は OpenTofu 1.12.5 で実行します。`required_version` がこのバージョンを
含まないと確認が失敗し、追加の画面には「追加できるかの確認を完了できませんでした。」と
表示されます。画面はもう一度試すよう案内しますが、この原因では何度試しても同じなので、
`required_version` を見直します。
