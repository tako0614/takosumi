# Takosumi Cloud Resources

Takosumi Cloud は、公式 managed targets 上で app / service / data resource を
提供する hosted Takosumi for Operator です。`EdgeWorker` は複数ある service
form の一つです。

```text
Takosumi Cloud Resources =
  EdgeWorker
  + ContainerService
  + ObjectBucket
  + KVStore
  + SQLDatabase
  + Queue
  + AI Gateway
  + managed routes / URLs / secrets
  + USD credits / usage metering
  + OpenTofu deploys
```

Cloudflare-compatible API は product identity ではありません。既存の
Cloudflare Workers 向け Terraform/OpenTofu manifest を Takosumi Cloud の
`EdgeWorker` と managed bindings へ取り込む import / deploy path です。

## Product Vocabulary

通常の landing / UI では次の語彙を使います。

- App / Service
- Edge Worker
- Container
- Bindings
- Routes
- Default URL
- Custom Domain (Planned)
- Secrets
- KV
- Object Storage
- Database
- Queue
- AI Gateway
- Durable Workflow

`compat.cloudflare.workers.v1` は architecture / compatibility docs の capability 名に
留めます。headline と主要 UI では Takosumi Cloud resources / services を主語にします。

## Runtime Architecture

`EdgeWorker` は edge JavaScript / TypeScript app の service form です。Takosumi
Cloud では Cloudflare Workers for Platforms と Takosumi-managed dispatch layer で
実装できます。

これは Cloud の実装詳細です。Cloud の resource model は `EdgeWorker` に限定しません。
OCI image で動く service は `ContainerService`、object storage は `ObjectBucket`、
relational / app database は `SQLDatabase`、durable workflow は別 shape として扱います。

```text
Edge JS app:
  EdgeWorker -> Cloudflare Workers for Platforms dispatch namespace

Container service:
  ContainerService -> Cloudflare Containers or another operator target

Durable user workflow:
  DurableWorkflow -> Dynamic Workers + @cloudflare/dynamic-workflows where available

Operator/internal jobs:
  Cloudflare Workflows
```

すべての Cloud managed resource は、実 backend API を叩く前に Cloud extension
共通層を通します。入口が Cloudflare-compatible OpenTofu provider、`takosumi/takosumi`
provider、Compatibility API、または Dashboard のどれであっても、認証、発生元
Workspace context、owner billing context、Resource / NativeResource への正規化、共通 managed operation
descriptor、selected manager の利用可否確認、usage / credit guard を通り、その後に
manager が backend を選びます。API entrypoint は user-facing protocol を決めるだけで、
backend choice は manager descriptor / dispatch plan の責務です。`takosumi_*` Resource Shape として入る場合は、
その前段で TargetPool / Policy / ResolutionLock も通ります。

```text
OpenTofu provider via compat / takosumi provider via Resource Shape API / Compatibility API / Dashboard action
  -> auth + source Workspace + owner billing account
  -> Resource / NativeResource normalization
  -> TargetPool / Policy / ResolutionLock (Resource Shape entrypoints)
  -> CloudManagedOperation
  -> CloudManagedDispatchPlan
  -> selected manager configured check
  -> usage / credit guard
  -> capability / manager dispatch
  -> selected manager
  -> backend API
```

manager が未設定の service form は、usage precharge より前に fail closed します。
つまり ContainerService などの backend がまだ official Cloud に入っていない場合、
credit だけ引かれたり、別の compatibility path に暗黙 fallback したりしません。
Worker route の作成・削除と managed default hostname も EdgeWorker の operation
として同じ resolver / dispatch plan に乗ります。route だけが compat handler の
内部都合で backend API を直接叩くことはありません。custom domain は Planned で、
現在は verification / certificate lifecycle がないため backend dispatch 前に
fail closed します。

この共通層では、Cloud-managed service form ごとに manager descriptor を持ちます。
descriptor は Takosumi Cloud の service family、usage meter family、
NativeResource type、現在の manager 実装を結びます。service family は
`takosumi.edge_worker` のような安定した Cloud resource 契約で、usage meter
family は billing / compat のための公開課金分類、manager は差し替え可能な backend
実装です。例えば `EdgeWorker` の現在 manager は Cloudflare Workers for Platforms
dispatch namespace ですが、public resource identity は `EdgeWorker` /
`takosumi.edge_worker`、課金 meter は互換 import path と価格表に合わせて
`cloudflare.workers_script` です。WfP は implementation token であり、ユーザー向けの
resource 名や課金単位にはしません。
同じ理由で、Cloud 内部の normalized resource kind は `object_bucket` /
`sql_database` / `durable_workflow` のような service form 寄りの名前にします。
`r2` や `d1` は Cloudflare-compatible URL token や現在の backend prefix に限定し、
共通 operation kind にはしません。

Cloudflare-compatible path はこの pipeline への import path です。EdgeWorker の現在の
公式 manager は Workers for Platforms dispatch namespace を使いますが、API contract
は `EdgeWorker` / `ObjectBucket` / `KVStore` / `SQLDatabase` / `Queue` などの service
form で固定し、WfP や Cloudflare primitive を public resource identity にはしません。
将来 manager を差し替える場合も、entrypoint URL や provider schema ではなく、
manager descriptor / TargetPool / adapter evidence を変える形にします。

参考:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Delete And Cleanup

Takosumi Cloud が管理する resource の delete は冪等です。すでに backend が消えている場合も
成功として扱い、同じ destroy を安全に再試行できます。cleanup / destroy は credits を使い切った
後も実行できます。

Object Storage のようにデータ量で所要時間が変わる resource は、delete を受理した後に background
cleanup で中身を分割削除します。受理された resource は active inventory と data plane から直ちに
外れ、cleanup 完了までは同じ名前を再利用できません。削除は取り消せず、保存データも復元できません。

ユーザー自身の ProviderConnection で作った BYOC resource は、元 provider の delete / retention
policy に従います。provider が retention lock や依存 resource を理由に拒否した場合、Takosumi は
destroy 成功を偽装せず、Run を失敗として記録して修正後の再試行を可能にします。

## Domains And Routes

公開 HTTP resource は、Takosumi 管理の URL を持てます。Takosumi Cloud の既定
base domain は `app.takos.jp` です。現在の allocation mode は `scoped` と
`vanity` の2種類です。

```text
scoped: https://<workspace-handle>-<label>.app.takos.jp
vanity: https://<label>.app.takos.jp
```

`scoped` は DNS ownership verification 不要で vanity 枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` を first-come-first-served で予約し、
Workspace の immutable owner account の有限枠を1つ消費します。どちらも hostname
reservation による global uniqueness、予約語、abuse policy の対象です。

Cloudflare compatibility の hostname を作る route / script-subdomain write も、
source Workspace と source Capsule の context を必須とし、同じ OSS hostname
reservation authority を通ります。Cloud 側の KV / Durable Object は route の
routing / activation state を持つだけで、hostname ownership の正本ではありません。

現在の Dashboard / OpenTofu route lifecycle は次を扱います。

| Field              | Status  | Meaning                                      |
| ------------------ | ------- | -------------------------------------------- |
| `default_hostname` | Current | scoped or owner-slot managed hostname        |
| `pattern`          | Current | route pattern used by compatibility imports  |
| `target`           | Current | EdgeWorker / ContainerService target         |
| `custom_domains`   | Planned | user-owned verified-domain lifecycle (unused) |

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>`、`vanity` は
`<label>.<managed-base-domain>` を予約します。
重複・枠超過エラーは claimant の Workspace / Capsule 名を公開しません。
managed hostname reservation と vanity slot は route record ではなく Capsule lifetime
に属します。成功した Capsule destroy が reservation を解放します。Cloud 側の route
DELETE は routing / activation state を削除するだけで、OSS hostname ownership を
解放しません。

ユーザー所有 custom domain は managed URL と別の verified lifecycle ですが、DNS
ownership verification と certificate lifecycle は未実装です。現在、非空の
`custom_domains` や managed base domain 外の route pattern は fail closed し、
routing / activation state に利用可能な custom domain として保存しません。

App install / Store では、この値は `installExperience` の
`public_endpoint` projection から普通の OpenTofu 変数へ渡します。例えば
`subdomain` は managed URL の label、`url` は managed URL または通常の OpenTofu
変数、`routePattern` は互換 API で使う route pattern です。ユーザー所有 URL を
BYOC provider に渡すことはできますが、Cloud managed target の custom domain として
自動有効化はしません。
Takosumi は `worker_name` や `app_url` という変数名だけを見て意味を推論しません。
store が明示した projection と input `format` だけが Dashboard の入力 UX と
hostname 予約の根拠です。

## Compatibility Matrix

Cloudflare import capability は `compat.cloudflare.workers.v1` です。
Workers-oriented resource を Takosumi Cloud resources に取り込むために必要な
subset だけを公開します。対応しない Cloudflare product は明示します。

| Status             | Scope                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Production Preview | Worker script deploy to `EdgeWorker`                                   |
| Production Preview | Worker routes to Takosumi routes / default hostnames                   |
| Production Preview | Worker secrets / vars                                                  |
| Production Preview | KV namespace                                                           |
| Production Preview | R2 bucket / Object Storage                                             |
| Production Preview | D1 database / App Database                                             |
| Preview            | Queue                                                                  |
| Preview            | Durable Workflow                                                       |
| Preview            | Dynamic Worker workflow support                                        |
| Planned            | Containers                                                             |
| Planned            | Durable Objects style stateful apps                                    |
| Planned            | User-owned custom domains                                              |
| Unsupported        | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported        | Email Routing                                                          |

AI Gateway は Workers compatibility ではありません。別の OpenAI-compatible
endpoint profile です。詳細は [Cloud endpoints](./endpoints.md#ai-gateway)
を参照してください。

## OpenTofu Import Path

Cloudflare-compatible API は、Cloudflare Workers-oriented manifest の import path
です。

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

docs では次の言い方にします。

```text
Deploy apps and managed resources to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when importing Workers-oriented apps.
```

本物の Cloudflare に向けるか Takosumi Cloud に向けるかは、引き続き
ProviderConnection / ProviderBinding で切り替えます。manifest に raw secret を
書いてはいけません。

Takosumi Cloud では、この import path は app installation 登録なしでも使えます。
ただし認証済み token と課金対象 Workspace は必須です。billable な write は
所有ユーザーの account credits から引かれ、残高不足なら compatibility endpoint の実行前に止まります。
