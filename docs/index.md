# Takosumi

Takosumi は、既存の OpenTofu/Terraform provider と module をそのまま実行する control plane です。
Takosumi Cloud では、ブラウザからサービスを追加し、必要な接続と変更内容を確認して、自分のクラウドへ deploy
できます。OSS では同じモデルをセルフホストして使えます。

## まず何ができるか

```text
1. サービスを選ぶ、または Git URL を貼る
2. 必要なクラウドアカウントを接続する
3. 作成・更新される内容を確認する
4. deploy を承認する
5. URL、履歴、state、outputs、activity を確認する
```

最初は [Quickstart](./getting-started/quickstart.md) から始めてください。

## Cloud と OSS

```text
Takosumi OSS:
  既存 Terraform/OpenTofu provider をそのまま実行する control plane。

Takosumi Cloud:
  closed な公式ホスティング版 Takosumi for Operators
  + Cloud 専用の compatibility gateway（Cloudflare / AI）
  + Cloud 専用の managed resources。
```

最重要境界はこれです。

```text
OSS は既存 provider をそのまま動かす。
Cloud だけが互換 API と managed resource を持つ。
```

## 画面で使う言葉

Takosumi Cloud の通常画面では、内部モデルをそのまま前面に出しません。

| 画面の言葉    | 意味                                              |
| ------------- | ------------------------------------------------- |
| サービス      | ホストするアプリ、worker、API、site、storage など |
| 接続          | Cloudflare / AWS / GCP などのアカウント連携       |
| 変更内容      | deploy 前に確認する plan / resource summary       |
| 履歴          | いつ誰が何を変更したか                            |
| Restore point | state version を使った復元点                      |

詳細を見たい場合は、OpenTofu/Terraform の model を [Model reference](./reference/model.md) で確認できます。

## Takosumi が管理すること

Takosumi は OpenTofu/Terraform の外側を管理します。

```text
サービスまたは Git repo を追加する
必要な Provider Connection を確認する
credential/env/file を Run 時だけ自動注入する
OpenTofu/Terraform を実行する
変更内容を確認して apply を承認する
state / outputs / run 履歴 / audit を保存する
```

Takosumi が中心にする価値はこれです。

```text
Same manifest, different connection.
```

同じ `.tf` を使い、Provider Binding だけを変えて dev/prod、別 account、別 provider alias に流せます。

## OSS がやらないこと

Takosumi OSS には以下を入れません。

```text
Cloudflare compatibility API
AWS/GCP compatibility API
S3 gateway
Resource Driver system
Compat Pack system
Managed Edge
Managed Container
Managed Storage
official billing/quota/usage
official cloud backend
```

Cloudflare compatibility gateway や managed resources は Takosumi Cloud 専用です。

## Takosumi Cloud

Takosumi Cloud は closed な公式ホスティング版です。

```text
Takosumi Cloud =
  official hosted Takosumi for Operators
  + Cloudflare Compatibility Gateway
  + Takosumi AI Gateway
  + Takosumi Managed Edge / Storage / DB / KV / Queue / Container
  + billing / quota / usage / support / abuse controls
```

互換 API はまず Cloudflare と AI Gateway に絞ります。その他の provider は
新しい互換 API を増やすのではなく、通常の OpenTofu/Terraform provider と
Provider Connection の env/file injection で動かします。

```text
cloudflare/cloudflare provider
  -> base_url = https://app.takosumi.com/compat/cloudflare/client/v4
  -> Takosumi Cloudflare Compatibility Gateway
  -> Takosumi Managed Edge internal API
```

対応範囲は Workers 系 subset から始めます。

```text
cloudflare_workers_script
cloudflare_workers_route
cloudflare_workers_kv_namespace
cloudflare_r2_bucket
cloudflare_d1_database
worker vars/secrets/bindings
```

AI Gateway は OpenAI-compatible な Cloud 専用 runtime API です。

```text
GET  /gateway/ai/v1/models
POST /gateway/ai/v1/chat/completions
POST /gateway/ai/v1/embeddings
```

## 次に読むもの

- [Quickstart](./getting-started/quickstart.md)
- [Model reference](./reference/model.md)
- [CLI reference](./reference/cli.md)
