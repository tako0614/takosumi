# Takosumi Cloud pricing

このページは Takosumi Cloud の公開価格と credit contract です。
ここに書くのはユーザー向けの価格、無料枠、残高不足時の挙動だけです。
payment-provider 同期、runtime price book、margin guard、原価見積もり、
reconciliation は公開 contract ではなく運用手順で管理します。

## Plans and Credit Packs

Takosumi Cloud は USD-denominated credit を使います。credit は Takosumi Cloud
上の usage ledger で消費する残高であり、現金として返金・換金できる USD では
ありません。

| Plan / pack          | Customer pays | Credit grant |
| -------------------- | ------------- | ------------ |
| Starter              | 980円 / month | `$3.00`      |
| `$5.00` balance pack | 1200円        | `$5.00`      |

Checkout と Dashboard の billing 表示は、この公開価格と一致している必要があります。
表示が食い違う場合は、購入や追加 charge を進めず support に連絡してください。

## Free Tier

各 Workspace は月ごとの無料枠を持てます。初期値は Workspace ごとに `$0.25 / month`
です。

```text
monthly included credit:
  $0.25 per Workspace per month
```

無料枠は繰り越しません。無料枠を超えた usage は、同じ usage price で購入済み
credit から引かれます。残高が足りない場合、billable な作成・deploy・runtime・
data-plane write/query/message/instance operation は実行前に止まります。

## Usage Prices

Usage は `usdMicros` を正本として記録します。Dashboard では USD 表示に丸める
ことがあります。

| Family               | Unit        | Customer price            |
| -------------------- | ----------- | ------------------------- |
| AI request           | request     | `$0.001` / request        |
| AI input tokens      | token       | `$0.30` / 1M tokens       |
| AI output tokens     | token       | `$1.00` / 1M tokens       |
| Workers Script       | operation   | `$0.001` / operation      |
| KV / D1 / R2 ops     | operation   | `$0.0005` / operation     |
| KV / D1 / R2 storage | GB-hour     | `$0.10` / 1M GB-hours     |
| Vector Index         | operation   | `$0.0005` / operation     |
| Workflows            | operation   | `$0.001` / operation      |
| Containers           | vCPU-second | `$1.00` / 1M vCPU-seconds |
| Queues               | operation   | `$0.0005` / operation     |
| Durable Objects      | operation   | `$0.0005` / operation     |

Preview / Planned の resource は、利用可能になった Workspace でだけ課金対象になります。
この表は価格 contract であり、すべての service が全ユーザーに有効化済みであることを
意味しません。利用可能性は [Takosumi Cloud](./index.md) の rollout matrix と
Dashboard の endpoint status で確認してください。

## Credit Exhaustion

Takosumi Cloud は billable write / deploy / runtime dispatch / data-plane operation
を実行前に precharge します。

```text
enough available credit:
  record usage event
  execute the operation

not enough available credit:
  fail closed before downstream execution
```

残高不足時は、Cloud endpoint、AI upstream、runtime dispatch、provider-compatible
write へ進みません。成功した billable operation は Workspace usage ledger に
usage event として記録され、billing projection に反映されます。

Destroy / DELETE cleanup は例外です。残高切れで作成済み resource を消せなくなる
状態を避けるため、cleanup は原則として追加 precharge なしで実行できるようにします。

## Secret and Billing Safety

Usage event、billing projection、catalog、status、model metadata に secret value を
入れてはいけません。

次の値は usage ledger に保存しません。

- provider credential
- API key / bearer token
- database URL / DSN / password
- upstream AI key
- payment provider secret

Cloud endpoint が usage を記録できない、価格が見つからない、Workspace context が
不正、scope が不足、または残高が足りない場合は fail closed します。
