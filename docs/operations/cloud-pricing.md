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

| family               | selector kind             | unit        | charge                    | estimated cost            |
| -------------------- | ------------------------- | ----------- | ------------------------- | ------------------------- |
| AI request           | `ai_request`              | request     | `$0.001` / request        | `$0.000` / request        |
| AI input tokens      | `ai_input_token`          | token       | `$0.30` / 1M tokens       | `$0.15` / 1M tokens       |
| AI output tokens     | `ai_output_token`         | token       | `$1.00` / 1M tokens       | `$0.50` / 1M tokens       |
| Workers Script       | `gateway_compute`         | operation   | `$0.001` / operation      | `$0.0001` / operation     |
| KV / D1 / R2 ops     | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |
| KV / D1 / R2 storage | `gateway_storage_gb_hour` | GB-hour     | `$0.10` / 1M GB-hours     | `$0.05` / 1M GB-hours     |
| Workflows            | `gateway_compute`         | operation   | `$0.001` / operation      | `$0.0001` / operation     |
| Containers           | `gateway_compute`         | vCPU-second | `$1.00` / 1M vCPU-seconds | `$0.50` / 1M vCPU-seconds |
| Queues               | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |
| Durable Objects      | `gateway_compute`         | operation   | `$0.0005` / operation     | `$0.0001` / operation     |

この表は細かい USD micro-credit で引き落とします。表示上は USD に丸めても、
ledger では `usdMicros` を正本にします。

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

止める対象:

- Cloudflare Compatibility Gateway 経由の Workers Script / KV / R2 / D1 / Queues / Workflows / Containers / Durable Objects
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
