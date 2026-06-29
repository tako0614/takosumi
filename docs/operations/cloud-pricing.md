# Takosumi Cloud pricing

このページは Takosumi Cloud の Cloud-only resource / AI Gateway の価格運用正本です。
Takosumi OSS / Takosumi for Operators の機能範囲ではありません。

## 原則

価格は Takosumi Cloud operator が決めます。
Cloud extension や互換 endpoint は利用量を報告するだけで、顧客向けの課金額を決めません。

```text
Cloud extension:
  meterId / kind / quantity / resource metadata を報告する

Takosumi Cloud platform worker:
  price book で usdMicros を確定する
  minimum gross margin を検証する
  Workspace balance から引く
  balance が足りなければ fail closed する
```

無料枠は利益を出す対象ではなく、上限付きの acquisition cost として扱います。
有料従量単価は単位ごとに positive gross margin を持つ必要があります。

Takosumi Cloud の価格正本はこの文書です。実行時の operator config
(`TAKOSUMI_BILLING_PLANS` と `TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`) は、この文書の
数字を production / staging に反映したものとして扱います。価格改定はこの文書を
先に更新し、その後 Stripe price / operator config / readiness evidence を更新します。

```text
pricing source of truth:
  takosumi/docs/operations/cloud-pricing.md

runtime plan catalog:
  TAKOSUMI_BILLING_PLANS

runtime usage price book:
  TAKOSUMI_CLOUD_USAGE_PRICE_BOOK
```

`TAKOSUMI_BILLING_PLANS` の各 entry には `estimatedNetRevenueUsdMicros` を必須にします。
これは Stripe 手数料、税・返金・為替 buffer を差し引いた保守的な operator 入金見積もりです。
readiness check は `usdMicros <= estimatedNetRevenueUsdMicros` を満たさない plan / pack を
落とします。つまり、実質入金より大きい USD 残高を売る事故は GA-ready になりません。

## Runtime config

価格表は platform worker の operator config に置きます。

```toml
TAKOSUMI_CLOUD_USAGE_PRICE_BOOK = '''{
  "minimumGrossMarginBps": 3000,
  "meters": [
    {
      "meterIdPrefix": "ai:",
      "kind": "ai_request",
      "unit": "request",
      "chargeUsdMicrosPerUnit": 1000,
      "estimatedCostUsdMicrosPerUnit": 0,
      "minimumChargeUsdMicros": 1000
    }
  ]
}'''
```

`minimumGrossMarginBps` は gross margin の下限です。`3000` は 30% を意味します。
gross margin 判定は次の式で行います。

```text
charge >= estimated_cost / (1 - minimumGrossMarginBps / 10000)
```

この条件を満たさない meter は usage ledger に記録せず、Cloud extension request を
`502` で fail closed します。価格表に meter が存在しない場合も fail closed です。

Cloud Edge Runtime は public user traffic を直接受けるため、usage header を client
response に出して platform worker に拾わせる経路ではありません。公式 Cloud では
この runtime handler も `takosumi-cloud/platform/worker.ts` に in-process mount
され、別 Worker としては deploy しません。handler は dispatch 前に同じ platform
Worker origin の `POST /internal/platform/cloud/usage` へ
`cloudflare:workers_script:request` meter を送り、platform worker 側の同じ
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` と atomic Workspace balance spend を再利用します。
token 未設定、`spaceId` 未設定、価格未設定、残高不足はすべて fail closed で、
user script は dispatch されません。

## Price book schema

各 meter entry は `meterId` または `meterIdPrefix` のどちらか一方を持ちます。
AI model のように meter id が model ごとに増えるものは `meterIdPrefix` と `kind`
でまとめます。

```json
{
  "meterIdPrefix": "ai:",
  "kind": "ai_input_token",
  "unit": "token",
  "chargeUsdMicrosPerMillionUnits": 300000,
  "estimatedCostUsdMicrosPerMillionUnits": 150000,
  "minimumChargeUsdMicros": 2
}
```

必須項目:

- `unit`
- exactly one of `meterId` / `meterIdPrefix`
- exactly one of `chargeUsdMicrosPerUnit` / `chargeUsdMicrosPerMillionUnits`
- exactly one of `estimatedCostUsdMicrosPerUnit` / `estimatedCostUsdMicrosPerMillionUnits`

任意 selector:

- `kind`
- `resourceFamily`
- `operation`

任意 billing guard:

- `minimumChargeUsdMicros`

`chargeUsdMicrosPerMillionUnits` / `estimatedCostUsdMicrosPerMillionUnits` を使う meter は、
small quantity の原価見積もりが `1` micro USD に切り上がることがあります。positive cost
meter で `minimumGrossMarginBps: 3000` を満たすには、初期設定では
`minimumChargeUsdMicros` を `2` 以上にします。

## Initial pricing

GA 前の初期 pricing は次を正本にします。数字は Takosumi Cloud の顧客向け単価であり、
Cloudflare の公開価格表をそのまま転記したものではありません。原価見積もりは margin guard
用の operator estimate です。

## Initial customer prices

初期の顧客向け価格はこれです。`$3.00` / `$5.00` は現金として返金・換金できる
USD ではなく、Takosumi Cloud の usage ledger で消費する USD-denominated balance です。

| plan / pack          | customer pays | balance grant | conservative net revenue estimate |
| -------------------- | ------------- | ------------- | --------------------------------- |
| Starter              | 980円 / month | `$3.00`       | `$4.00`                           |
| `$5.00` balance pack | 1200円        | `$5.00`       | `$5.00`                           |

この表は `TAKOSUMI_BILLING_PLANS` に次の意味で反映します。

```json
{
  "id": "starter",
  "kind": "subscription",
  "stripePriceId": "price_...",
  "usdMicros": 3000000,
  "estimatedNetRevenueUsdMicros": 4000000,
  "name": { "ja": "Starter", "en": "Starter" },
  "priceDisplay": {
    "ja": "月額980円 / $3.00 残高",
    "en": "JPY 980 / month, $3.00 balance"
  }
}
```

`estimatedNetRevenueUsdMicros` は UI / public API には出しません。operator readiness と
finance review のための非 secret config です。

## Initial usage price book

この表は Takosumi Cloud が価格を決めるための初期 price book です。price book に
meter が存在することは、その Cloud extension route が GA 公開済みであることを
意味しません。公開対象にするには、その resource family ごとに precise usage
header、または `fallbackUsage` と preauthorization、usage ledger smoke、destroy /
deprovision proof が揃っている必要があります。

| family               | resourceFamily / meter selector                         | selector kind             | unit        | charge                    | estimated cost            |
| -------------------- | ------------------------------------------------------- | ------------------------- | ----------- | ------------------------- | ------------------------- |
| AI request           | `ai:`                                                   | `ai_request`              | request     | `$0.001` / request        | `$0.000` / request        |
| AI input tokens      | `ai:`                                                   | `ai_input_token`          | token       | `$0.30` / 1M tokens       | `$0.15` / 1M tokens       |
| AI output tokens     | `ai:`                                                   | `ai_output_token`         | token       | `$1.00` / 1M tokens       | `$0.50` / 1M tokens       |
| Workers Script       | `cloudflare.workers_script` / `cloudflare:workers_script:` | `gateway_compute`         | operation   | `$0.001` / operation      | `$0.0001` / operation     |
| KV / D1 / R2 ops     | `cloudflare.kv` / `cloudflare.d1` / `cloudflare.r2`     | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |
| KV / D1 / R2 storage | `cloudflare.kv` / `cloudflare.d1` / `cloudflare.r2`     | `gateway_storage_gb_hour` | GB-hour     | `$0.10` / 1M GB-hours     | `$0.05` / 1M GB-hours     |
| Workflows            | `cloudflare.workflows` / `cloudflare:workflows:`        | `gateway_compute`         | operation   | `$0.001` / operation      | `$0.0001` / operation     |
| Containers           | `cloudflare.containers` / `cloudflare:containers:`      | `gateway_compute`         | vCPU-second | `$1.00` / 1M vCPU-seconds | `$0.50` / 1M vCPU-seconds |
| Queues               | `cloudflare.queues` / `cloudflare:queues:`              | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |
| Durable Objects      | `cloudflare.durable_objects` / `cloudflare:durable_objects:` | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |

この表は細かい USD micro-credit で引き落とします。表示上は USD に丸めても、
ledger では `usdMicros` を正本にします。

AI Gateway の streaming response は response header を先に返す必要があるため、
token-only pricing では公開しません。streaming を許可する public model は必ず
nonzero `ai_request` meter を持ち、input/output token meter は非 streaming JSON
response で upstream が usage を返した場合の追加 meter として扱います。
runtime config も同じ制約です。`TAKOSUMI_AI_GATEWAY_ALLOW_UNMETERED_MODELS=1`
を明示した local development 以外では、billing meter を持たない public model は
AI Gateway の config parser が拒否します。

Cloud extension の write / deploy route は `fallbackUsage` を持つ場合、
upstream を呼ぶ前に platform worker が price book で課金額を決め、Workspace USD
balance から atomic に spend します。残高不足なら Cloudflare API や AI upstream は
呼びません。extension response が同じ request meter を返した場合は二重課金せず、
AI token meter や storage inventory meter のような追加 usage だけを成功後に記録します。
DELETE cleanup は例外です。残高切れで destroy / app removal / provider-side cleanup
が詰まると危険なので、DELETE は fallback precharge を持たせず、deprovision proof と
audit だけを残します。

`gateway_storage_gb_hour` は create/delete の操作課金ではありません。Cloud extension
または operator metering job が provider-side inventory から byte size と計測期間を
取得し、GB-hour quantity と `periodStart` / `periodEnd` を持つ usage header / usage
event として記録する必要があります。request handler が実サイズを知らない状態で
固定 quantity を出してはいけません。
closed `takosumi-cloud` package では、この共通変換を
`storageInventoryUsageReports()` として実装します。collector は resource ごとの
平均 bytes と実 period を渡し、helper は Workspace ごとに
`gateway_storage_gb_hour` usage header を作ります。単価と USD debit は引き続き
platform worker の price book が決めます。

実運用では collector は `POST /cloud/usage/storage-inventory` を
`cloud_extensions` Seam A 経由で呼びます。この endpoint は closed
Cloud usage handler にあり、official Cloud wrapper が platform worker 内で
in-process mount します。platform が検証した billing Workspace context と request
body の `workspaceId` を照合してから usage header を返します。
header は client response から削除され、platform worker が price book で
`usdMicros` を確定して Workspace usage ledger に記録します。1 request に複数
Workspace を混ぜないでください。複数 Workspace の inventory は Workspace ごとに
分割して送ります。

Containers / Durable Objects のような compute / operation usage を backend が
実測する場合は、同じ Cloud usage extension handler の
`POST /cloud/usage/resource-meters` に public meter を送ります。この endpoint は
現時点で `cloudflare.containers` と `cloudflare.durable_objects` だけを受け付け、
request body の `usdMicros` / `credits` は拒否します。単価は必ず platform worker の
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` で決まります。この metering path があることは、
Containers / Durable Objects の lifecycle UI や customer-facing managed resource
提供が完了していることを意味しません。公開には別途 lifecycle / destroy proof と
runtime guard smoke が必要です。

```json
{
  "basePath": "/cloud/usage",
  "handlerKey": "TAKOSUMI_CLOUD_USAGE",
  "requiredScopes": ["cloud.usage.write"]
}
```

## Free tier

無料枠は monthly included USD grant として扱います。初期値は Workspace ごとに
`$0.25 / month` までです。無料枠は繰り越さず、複数 Workspace 作成で無限に増やせないよう
closed access / abuse controls / account limit と一緒に運用します。

```text
monthlyIncludedUsdMicros:
  毎月付与する無料利用枠 (initial: 250000 = $0.25)

purchasedUsdMicros:
  ユーザーが購入した残高

availableUsdMicros:
  monthly included + purchased の残額
```

無料枠を超えた usage は同じ price book で有料残高から引きます。`availableUsdMicros`
が不足したら WfP / AI / managed resources は fail closed します。無料枠の範囲を
超えても silently free にしてはいけません。

## What stops when balance is exhausted

`recordGatewayResourceUsage` は Cloud extension route からの usage に
`spendRequired: true` を付けます。これにより workspace billing mode がまだ
`disabled` / closed access の状態でも、Takosumi Cloud が提供する有料 resource は
残高不足で止まります。

Cloud extension が usage header を返す経路では、成功 response 後に platform worker
が価格表で `usdMicros` を決め、atomic spend を行います。header 未配線で
`fallbackUsage` によって課金する mutating route は、bound Cloud service を呼ぶ前に
同じ価格表で必要額を計算し、Workspace の `availableUsdMicros` が不足していれば
`402 cloud_extension_insufficient_credits` を返します。つまり、明らかに残高不足の
deploy / create / delete / runtime execution は upstream side effect を起こしません。

止める対象:

- Cloudflare Compatibility Gateway 経由の Workers Script / KV / R2 / D1 / Queues / Workflows
- Cloud extension smoke と usage ledger evidence が通った Containers / Durable Objects
- Takosumi AI Gateway
- Takosumi Cloud managed resource backend

止めない対象:

- OSS Takosumi の OpenTofu run ledger
- ユーザー自身の Provider Connection で直接使う外部 provider
- operator showback-only usage

## Stripe

Stripe の plan / pack は残高を売る入口です。Stripe の表示価格と Takosumi の
`usdMicros` grant は別の値です。

```text
Stripe payment:
  ユーザーから受け取る fiat 金額

Takosumi credit:
  Workspace に付与する usdMicros 残高

Usage price book:
  Cloud resource usage を usdMicros に変換する単価表
```

利益構造は次で管理します。

```text
fiat revenue from Stripe
  > payment fee
  + upstream provider cost
  + free tier cost
  + support/abuse reserve
```

ただし runtime の fail-closed guard は unit usage の gross margin を守るものです。
Stripe 手数料、返金、為替、税、サポート費用は monthly finance review で別途確認します。
