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
- provider は `required_providers` に `source` つきで宣言します。`hashicorp/` 以外の provider
  は `source` が無いと別の provider として扱われます。
- provider block に認証情報を書きません。`token`、`api_token`、`api_key`、`access_key`、
  `secret_key`、`client_secret`、`password` という名前の属性は、変数から渡す場合も
  止められます。認証情報は、実行のときに接続（Connection）から環境変数かファイルで渡ります
  （[認証情報](../concepts/credentials.md)）。
- 動く例は [`examples/opentofu-basic`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-basic)
  （provider なし）と
  [`examples/opentofu-null-provider`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-null-provider)
  （provider を 1 つ使う最小の例）です。

## 追加できなくなるもの

| 書いたもの | 直し方 |
| --- | --- |
| registry や `git::` など、リモートの module source | 使う module をリポジトリに入れ、`./` から始まるパスで参照します。バージョンを固定していてもリモートは使えません |
| 選んだ module のディレクトリの外を指す `../` の module source | 必要な module を、選ぶ module のディレクトリの中に置きます |
| `.tf.json` の設定ファイル | 同じ内容を HCL（`.tf`）で書きます |
| provisioner（`local-exec`、`remote-exec`、`file`） | 削除します。運用している人が許可した場合だけ使えます |
| `external` data source | 削除します。運用している人が許可した場合だけ使えます |
| `path.root`、`abspath()`、`pathexpand()`、`/` や `~` から始まるパスや `..` を含むパスのファイル読み込み | module の中のファイルか、変数で渡します |
| `ephemeral` な root output、`sensitive` に `true`/`false` 以外の式 | `sensitive` と `ephemeral` は `true` か `false` をそのまま書きます |
| 追跡している symbolic link、Git submodule | 実体のファイルとしてリポジトリに入れます |

Takosumi が読む範囲の中に問題のある `.tf` が 1 つでもあると、その範囲の module はすべて
追加できなくなります。読む範囲は、既定ではリポジトリ全体です。テスト用や例の module が
同じリポジトリにあるときは、追加リンクの `sourcePath`（Source の `defaultPath`）で、読む
範囲を本体の module のディレクトリに絞ります（[Source と Capsule](../concepts/sources.md)）。

## 変数と output

- `default` の無い変数は、追加するときに入力が必須になります。`default = null` は任意です。
- `string`、`number`、`bool` はそのまま入力し、`list`、`map`、`object` などは JSON の値として入れます。
- 変数の `sensitive = true` は、入力を秘密として扱う指定になりません。秘密の入力は
  [Repository manifest](../reference/repository-manifest.md) の `inputs[].secret` で指定します。
- output のうち、`sensitive` でないものが Workspace に記録されます。名前に `token`、`secret`、
  `password`、`key`、`auth`、`session` などを `_` や `-` で区切って含むもの（例:
  `public_key`、`auth_url`）や、値が秘密に見えるものは公開されません
  （[状態と出力](../concepts/state-and-outputs.md)）。

## 無くてもよいもの

- `.well-known/takosumi.json`（[Repository manifest](../reference/repository-manifest.md)）
  は任意です。入力欄の説明、秘密の入力、Interface などを足したいときだけ置きます。
- `.terraform.lock.hcl` は任意です。無ければ確認のときに作られ、変更の確認（plan）で固定
  されます。置く場合は、OpenTofu（`tofu init`）が作ったものを commit します。

## 大きさの上限

| 対象 | 上限 |
| --- | --- |
| 設定ファイル | 256 個、1 個 1 MiB、合計 4 MiB |
| 見つかる root module | 32 個 |
| ディレクトリの深さ | 64 階層 |
| 取得するリポジトリの範囲（archive） | 既定 50 MiB（運用している人が変えられます） |

## OpenTofu のバージョン

標準の runner は OpenTofu 1.12.5 で実行します。`required_version` がこのバージョンを
含まないと確認が失敗し、追加の画面には「追加できるかの確認を完了できませんでした。」と
表示されます。もう一度試しても同じなので、`required_version` を見直します。
