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

ただし、既存の汎用 OpenTofu provider や標準 API で足りるものは Takosumi が作り直しません。Takosumi
の shape は、provider-neutral な service form、binding、policy、metering、import path が必要なときだけ使います。
逆に、汎用 provider がないだけで即 `takosumi_*` resource にするわけでもありません。一回限りの不足は
generic-env ProviderConnection と通常の OpenTofu module で扱い、繰り返し使う service form として schema /
planner / adapter / state / import / drift の意味が固まるものだけを Takosumi provider に追加します。

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
takosumi_provider-compatible API
```

互換 API は capability として公開範囲を宣言します。例: `compat.oci.v1`、`compat.cloudevents.v1`、
`compat.cloudflare.workers.v1`。これらは標準 API を作り直すロードマップではありません。`compat.s3.v1` は
operator が ObjectBucket の data/control compatibility を意図的に公開するときの profile であり、普通の S3/R2/GCS
利用は既存 provider を使います。
full AWS compatibility や full Cloudflare compatibility を名乗らず、scope と version を明示します。

詳細な Resource Shape / compatibility capability model は
[Takosumi Final Plan](https://github.com/tako0614/takosumi/blob/main/docs/final-plan.md) を参照してください。

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

Takosumi Cloud では Worker-compatible hosting、managed bindings、AI Gateway、credits などを公式 managed service として提供します。

[Takosumi Cloud](./cloud/index.md) に、公開用の compatibility matrix と service rollout をまとめています。

Cloudflare Workers-compatible profile は、既存 Workers app の import / deploy path として扱います。互換 API は
versioned subset であり、Cloudflare API 全体の完全互換ではありません。

AI は `AIEndpoint` Resource Shape として扱います。OpenAI互換 API は
profile / compatibility surface の一つで、実際に Cloudflare AI Gateway、
Workers AI、OpenAI互換 upstream、Gemini、DeepSeek、GLM、Bedrock、Vertex
AI、Takosumi native のどれで提供するかは operator/engine の capabilities
と policy が決めます。Takosumi Cloud では公式 managed AI Gateway を提供します。

```text
GET  /gateway/ai/v1/models
POST /gateway/ai/v1/chat/completions
POST /gateway/ai/v1/embeddings
```

## 次に読むもの

- [Quickstart](./getting-started/quickstart.md)
- [Takosumi Cloud](./cloud/index.md)
- [Model reference](./reference/model.md)
- [CLI reference](./reference/cli.md)
