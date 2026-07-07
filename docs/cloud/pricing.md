# Takosumi Cloud pricing

このページは Takosumi Cloud の公開価格と billing contract です。
ここに書くのはユーザー向けの価格、無料枠、上限到達時の挙動だけです。
payment-provider 同期、runtime price book、margin guard、原価見積もり、
reconciliation は公開 contract ではなく運用手順で管理します。

## Subscription Plans

Takosumi Cloud は月額 subscription と従量課金を組み合わせます。ユーザー向けには
「何ドル分使える」という credit grant を plan 表示に出しません。AI サービスの
ように、プラン名、月額、従量課金の有無、利用上限、支払い設定を見せます。

| Plan    | Customer pays | Public billing model       |
| ------- | ------------- | -------------------------- |
| Lite    | `$1` / month  | Base subscription + usage  |
| Plus    | `$5` / month  | Subscription with usage    |
| Pro     | `$10` / month | Subscription with usage    |

Checkout と Dashboard の billing 表示は、この公開価格と一致している必要があります。
表示が食い違う場合は、購入やプラン変更を進めず support に連絡してください。

## Usage and Limits

Takosumi Cloud の内部 ledger は USD micro-unit で usage を記録します。ただし、
subscription plan の内部 allowance や原価計算用の値は public plan display には
出しません。Dashboard では必要に応じて利用量、請求対象 operation、支払い状態、
上限、履歴を表示します。

```text
subscription:
  public: plan name + monthly price + usage billing
  internal: allowance / usage ledger / spend guard
```

有料の作成・deploy・runtime・data-plane write/query/message/instance operation は
実行前に spend guard を通ります。支払い設定、上限、内部 allowance、または利用可能な
利用可能な枠が足りない場合、下流の Cloud endpoint / AI upstream / runtime dispatch /
provider-compatible write へ進む前に fail closed します。

## Usage Prices

Usage は内部的に `usdMicros` を正本として記録します。下の単価は従量課金の
customer-facing rate です。

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

Preview / Planned の resource は、利用可能になった account / Workspace でだけ課金対象になります。
この表は価格 contract であり、すべての service が全ユーザーに有効化済みであることを
意味しません。利用可能性は [Takosumi Cloud](./index.md) の rollout matrix と
Dashboard の endpoint status で確認してください。

## Spend Guard

Takosumi Cloud は billable write / deploy / runtime dispatch / data-plane operation
を実行前に precharge / authorization します。

```text
allowed by plan / spending limit:
  record usage event
  execute the operation

not allowed:
  fail closed before downstream execution
```

支払い設定や上限の都合で利用できない場合は、Cloud endpoint、AI upstream、
runtime dispatch、provider-compatible write へ進みません。成功した billable
operation は owner account usage ledger に usage event として記録され、発生元 Workspace を attribution として残し、billing
projection に反映されます。

Destroy / DELETE cleanup は例外です。上限到達で作成済み resource を消せなくなる
状態を避けるため、cleanup は原則として追加 precharge なしで実行できるようにします。

## 自分のカギ (bring your own key) は課金しません

Takosumi Cloud が課金するのは Takosumi 提供の managed リソース (subscription と上の
Usage Prices の meter) だけです。あなたが自分の Provider Connection (自分のカギ) で
接続する外部 provider は、その provider から直接課金され、Takosumi は metering も
spend guard もしません。残高が尽きても、自分のカギで動かす provider の run と OSS の
OpenTofu run ledger は止まりません。provider の選択に allowlist / 承認はありません。

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
不正、scope が不足、または支払い状態 / 上限が不足している場合は fail closed します。
