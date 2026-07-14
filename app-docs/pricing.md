# Takosumi Cloud pricing

このページは Takosumi Cloud の公開価格と billing contract です。
ここに書くのはユーザー向けの価格、無料枠、上限到達時の挙動だけです。
payment-provider 同期、versioned PriceCatalog、原価見積もり、
reconciliation は公開 contract ではなく運用手順で管理します。

## Subscription Plans

Takosumi Cloud は月額 subscription と従量課金を組み合わせます。ユーザー向けには
「何ドル分使える」という credit grant を plan 表示に出しません。AI サービスの
ように、プラン名、月額、従量課金の有無、利用上限、支払い設定を見せます。

| Plan | Customer pays | Public billing model      |
| ---- | ------------- | ------------------------- |
| Lite | `$1` / month  | Base subscription + usage |
| Plus | `$5` / month  | Subscription with usage   |
| Pro  | `$10` / month | Subscription with usage   |

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
実行前に spend guard を通ります。支払い設定、上限、内部 allowance のいずれかで
利用できる枠が足りない場合、下流の Cloud endpoint / AI upstream / runtime dispatch /
provider 互換 write へ進む前に安全側に停止します (fail closed)。

## Service Prices

Takosumi Cloud の価格単位は provider API family ではなく、versioned
`ServiceOffering` / SKU です。`EdgeWorker` が内部で Workers for Platforms を使うか、
`ObjectBucket` が R2 を使うかは価格表の public noun ではありません。作成前の Preview
には offering version、SKU version、PriceCatalog version、税区分、単価、見積合計、
有効期限が表示され、Apply はその exact quote を再確認します。

現在、GA 用の Stable offering はまだ operator catalog に activate されていません。
そのため旧 provider-family 単価表は撤回し、正式な version / effective-at / price が
Dashboard Preview とこのページの両方に反映されるまで、Cloud Resource の購入と Apply
は fail closed のままです。GA 時に公開する最小表は次の形式です。

| Service form | Offering / SKU version | Effective at | Billable item / unit | Customer price | Availability |
| ------------ | ---------------------- | ------------ | -------------------- | -------------- | ------------ |
| EdgeWorker   | 未 activate            | —            | —                    | —              | Blocked      |
| ObjectBucket | 未 activate            | —            | —                    | —              | Blocked      |

AI Gateway は Resource lifecycle authority ではありませんが、課金を有効にする場合は同じ
PriceCatalog に versioned SKU と request/token price を持ちます。価格のない meter、複数
SKU に曖昧に一致する meter、未発効 catalog は課金や backend 実行へ進みません。

## Spend Guard

Takosumi Cloud は、課金対象の write / deploy / runtime dispatch / data-plane operation
を実行する前に、事前承認 (precharge) を行います。

```text
allowed by plan / spending limit:
  record usage event
  execute the operation

not allowed:
  fail closed before downstream execution
```

支払い設定や上限の都合で利用できない場合は、Cloud endpoint、AI upstream、
runtime dispatch、provider 互換 write へ進みません。成功した課金対象 operation は
所有アカウントの使用履歴に usage event として記録され、発生元の Workspace も
記録に残り、請求の集計に反映されます。

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
不正、scope が不足、または支払い状態 / 上限が足りない場合は、安全側に停止します。
