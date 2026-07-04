# Takosumi

Takosumi は Git を source of truth にする OpenTofu control plane です。普通の
OpenTofu/Terraform module をそのまま実行でき、`takosumi_*` Resource Shape を Target / Adapter に解決することもできます。
Takosumi Cloud は、その Takosumi を私たちが公式に運用する hosted service です。

## まず何ができるか

```text
1. サービスを選ぶ、または Git URL を貼る
2. 必要なクラウドアカウントを接続する
3. 作成・更新される内容を確認する
4. deploy を承認する
5. URL、履歴、state、outputs、activity を確認する
```

最初は [Quickstart](./getting-started/quickstart.md) から始めてください。

## Docs の境界

この docs は公開 product docs です。外部のユーザーや operator が依存できる
product definition、API、Resource Shape、Compatibility API、Cloud の公開 contract
を書きます。

開発中の最終計画、core conformance、運用手順、secret rotation、private evidence、
pricing の実値、Stripe 同期手順、closed handler wiring は公開 docs ではなく
`internal/` または `operations/` 側で管理します。公開 build では
`internal/**/*.md` と `operations/**/*.md` を除外します。

内部メモの内容が安定した public contract になった場合は、内部ページへリンクせず、
必要な情報だけを `reference/`、`cloud/`、`getting-started/` に書き直します。

## Cloud と OSS

```text
Takosumi OSS:
  Git-based OpenTofu control plane
  + Resource Shape API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Policy
  + Compatibility API framework
  + Adapter system。

Takosumi for Operator:
  Takosumi
  + customer management
  + billing / metering / quota
  + operator console
  + managed target catalog
  + commercial operation。

Takosumi Cloud:
  公式 hosted Takosumi for Operator
  + official managed targets
  + Cloud-operated managed service backends
  + official billing / SLA / support。
```

最重要境界はこれです。

```text
OSS は portable framework と API を持つ。
Operator / Cloud は商用運用と managed capacity を持つ。
```

## 画面で使う言葉

通常画面では、内部モデルをそのまま前面に出しません。

| 画面の言葉    | 意味                                              |
| ------------- | ------------------------------------------------- |
| サービス      | ホストするアプリ、worker、API、site、storage など |
| 接続          | Cloudflare / AWS / GCP などのアカウント連携       |
| 変更内容      | deploy 前に確認する plan / resource summary       |
| 履歴          | いつ誰が何を変更したか                            |
| Restore point | state version を使った復元点                      |

詳細を見たい場合は、OpenTofu/Terraform の model を [Model reference](./reference/model.md) で確認できます。
外部の web / desktop / mobile / CLI からサービス作成へつなぐ場合は
[App Handoff Protocol](./reference/app-handoff.md) を使います。

## Takosumi が管理すること

Takosumi は OpenTofu/Terraform の外側を管理します。

```text
サービスまたは Git repo を追加する
必要な Provider Connection を確認する
credential/env/file を Run 時だけ自動注入する
OpenTofu/Terraform を実行する
Resource Shape を Target / Adapter に解決する
変更内容を確認して apply を承認する
state / outputs / run 履歴 / audit を保存する
```

Takosumi が中心にする価値はこれです。

```text
Same manifest, different connection.
Same shape, different target.
```

同じ `.tf` を使い、Provider Binding だけを変えて dev/prod、別 account、別 provider alias に流せます。
同じ Resource Shape を使い、TargetPool / policy / Adapter によって、operator が有効化した target へ解決できます。

ただし、既存の industry-standard API / protocol / OpenTofu provider で足りるものは Takosumi が作り直しません。
新しい `takosumi_*` resource を増やす前に、既存 provider / 標準 surface / generic-env
ProviderConnection で足りるかを先に確認します。Takosumi の shape は、標準 surface がなく、繰り返し使う
service form として schema / planner / adapter / state / import / drift の意味が固まるものだけに追加します。
S3-compatible API、OCI registry、Kubernetes CRD、CloudEvents、OpenAI-compatible endpoint などの標準面は
そのまま外部 surface として使います。
Takosumi を使うために `takosumi/takosumi` provider が必須なわけではありません。既存の汎用 provider が
十分なら Stack flow でそのまま使い、Takosumi provider は Takosumi が所有する typed Resource Shape が必要な場合だけ使います。

公開 API の詳しい境界は [Takosumi API](./reference/api.md) にまとめています。

## OSS に含まれること

Takosumi OSS は framework を含みます。

```text
Git integration
OpenTofu runner
state / run history / audit
Resource Shape API
Resolver / Planner / Reconciler
TargetPool
Credential / OIDC / Secret / Policy
Compatibility API framework
Adapter framework
typed Resource API for provider / CLI / dashboard / CRD
scoped compatibility API surfaces
```

互換 API は capability として公開範囲を宣言します。例: `compat.oci.v1`、`compat.cloudevents.v1`、
`compat.cloudflare.workers.v1`。これらは標準 API を作り直すロードマップではありません。`compat.s3.v1` は
operator が object-storage の data/control compatibility を意図的に公開するときだけの profile であり、普通の
S3/R2/GCS 利用は既存 provider や標準 endpoint を使います。
full AWS API compatibility や full Cloudflare API compatibility を名乗らず、scope と version を明示します。

公開 API の境界は [Takosumi API](./reference/api.md)、Resource Shape の語彙は
[Model reference](./reference/model.md) を参照してください。

## Operator / Cloud の運用

商用運用と公式 managed capacity は Operator / Cloud の層です。

```text
customer management
billing / metering / quota / plan
operator console
managed target catalog
official managed target pools
official native runtime / object store / queue / DB / edge gateway
official SLA / support / abuse controls
```

Takosumi Cloud は公式 hosted operation です。

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed targets
  + Cloud-operated managed service backends
  + official billing / SLA / support
```

Takosumi Cloud では EdgeWorker、Container、Object Storage、KV、Database、
Queue、AI Gateway、credits などを公式 managed resources として提供します。

[Takosumi Cloud](./cloud/index.md) に、公開用の compatibility matrix と service rollout をまとめています。

Cloudflare Workers-compatible profile は、既存 Workers app の import / deploy path として扱います。互換 API は
versioned subset であり、Cloudflare API 全体の完全互換ではありません。

AI は Resource Shape ではなく、Takosumi Cloud / Operator が提供できる
OpenAI-compatible service endpoint として扱います。アプリには
ProviderConnection、Secret、output projection、generic env から
`OPENAI_BASE_URL` / `OPENAI_API_KEY` / model 名を渡します。
Takosumi Cloud では公式 managed AI Gateway を提供します。

```text
GET  /gateway/ai/v1/models
POST /gateway/ai/v1/chat/completions
POST /gateway/ai/v1/embeddings
```

## 次に読むもの

- [Quickstart](./getting-started/quickstart.md)
- [Takosumi Cloud](./cloud/index.md)
- [Model reference](./reference/model.md)
- [Takosumi API](./reference/api.md)
- [App Handoff Protocol](./reference/app-handoff.md)
- [CLI reference](./reference/cli.md)
