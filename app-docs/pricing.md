# Takosumi Cloud pricing

Takosumi Cloud は月額 subscription と従量課金を組み合わせた、税別 USD
価格の managed developer platform です。すべての plan で同じサービスを利用でき、
Resource 数は plan 特典ではなく共通の安全上限です。

## Subscription Plans

| Plan |  月額 | 毎月の managed usage grant | 超過分   |
| ---- | ----: | -------------------------: | -------- |
| Lite |  `$1` |                    `$0.50` | 従量課金 |
| Plus |  `$5` |                    `$3.00` | 従量課金 |
| Pro  | `$10` |                    `$7.00` | 従量課金 |

grant は billing period ごとに付与され、現金化・翌月繰越はできません。自分の
Provider Connection を使う外部 provider は grant の対象外で、その provider から
直接請求されます。

## Usage Prices

Cloudflare-backed capacity は、その provider の公開 overage / marginal rate の
`1.5x` を retail price とします。共有 free tier と platform 固定費は subscription
側で吸収し、tenant ごとの隠れた free tier にはしません。価格変更は version と
effective date を持ち、過去の usage を再計算しません。

| Service                          | Billable item                         |                                                              Price |
| -------------------------------- | ------------------------------------- | -----------------------------------------------------------------: |
| Edge Worker                      | requests                              |                                                  `$0.45 / million` |
| Edge Worker                      | CPU                                   |                                           `$0.03 / million CPU-ms` |
| Edge Worker                      | active script                         |                                             `$0.03 / script-month` |
| Edge Worker                      | log events                            |                                                  `$0.90 / million` |
| Edge Worker                      | Logpush events                        |                                                 `$0.075 / million` |
| Custom Domain                    | active verified hostname              |                                           `$0.15 / hostname-month` |
| Object Storage Standard          | storage                               |                                               `$0.0225 / GB-month` |
| Object Storage Standard          | Class A / Class B                     |                              `$6.75 / million` / `$0.54 / million` |
| Object Storage Infrequent Access | storage                               |                                                `$0.015 / GB-month` |
| Object Storage Infrequent Access | Class A / Class B                     |                             `$13.50 / million` / `$1.35 / million` |
| Object Storage Infrequent Access | retrieval                             |                                                      `$0.015 / GB` |
| KV                               | reads                                 |                                             `$0.75 / million keys` |
| KV                               | writes / deletes / lists              |                                             `$7.50 / million keys` |
| KV                               | storage                               |                                                 `$0.75 / GB-month` |
| Database                         | rows read / written                   |                                    `$0.0015` / `$1.50` per million |
| Database                         | storage                               |                                                `$1.125 / GB-month` |
| Queue                            | operations                            |                                     `$0.60 / million 64 KB chunks` |
| Vector Index                     | queried dimensions                    |                                                 `$0.015 / million` |
| Vector Index                     | stored dimensions                     |                                             `$0.075 / 100 million` |
| Durable Workflow                 | invocation / CPU                      |                       `$0.45 / million` / `$0.03 / million CPU-ms` |
| Durable Workflow                 | state / steps                         |                       `$0.30 / GB-month` / `$1.20 / 100,000 steps` |
| Container                        | memory / CPU / disk                   | `$0.00000375 / GiB-s`, `$0.000030 / vCPU-s`, `$0.000000105 / GB-s` |
| Container                        | egress: NA+EU / Oceania+KR+TW / other |                             `$0.0375` / `$0.075` / `$0.060` per GB |
| Stateful Actor                   | requests / duration                   |                       `$0.225 / million` / `$18.75 / million GB-s` |
| Stateful Actor                   | rows read / written                   |                                    `$0.0015` / `$1.50` per million |
| Stateful Actor                   | SQL storage                           |                                                 `$0.30 / GB-month` |
| AI Gateway                       | model/upstream usage                  |        approved upstream price `x 1.5` + Edge Worker gateway usage |

Object Storage の delete / abort / internet egress、preview、binding、secret設定、
route、schedule、static asset control、observe、refresh、delete は明示的な `$0`
meter です。ただし、それらが起動した runtime / storage usage は該当サービスの
meter で課金されます。Workflow の state / step 価格は `2026-08-10` より前は
`$0` catalog を使い、それ以降だけ上の価格を使います。

基準原価は Cloudflare の現行公式価格です:
[Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)、
[R2](https://developers.cloudflare.com/r2/pricing/)、
[KV](https://developers.cloudflare.com/kv/platform/pricing/)、
[D1](https://developers.cloudflare.com/d1/platform/pricing/)、
[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、
[Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/)、
[Workflows](https://developers.cloudflare.com/workflows/reference/pricing/)、
[Containers](https://developers.cloudflare.com/containers/pricing/)、
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)。

## Preview and invoice contract

作成前の Preview は offering / SKU / PriceCatalog version、税区分、単価、見積、
有効期限を返します。Apply はその exact quote だけを受け付けます。価格がない
meter、未発効 catalog、未設定 manager、期限切れ quote は backend 実行前に
fail closed します。

使用量は最小単位の整数で集計してから billing unit に丸めます。小数を event
ごとに切り上げることはありません。請求期間は immutable usage、reservation、
refund / credit と Stripe invoice line が一致するまで close しません。

## Tax

表示価格は税別です。Checkout と invoice は Stripe automatic tax を使います。
personal-use PaaS は `txcd_10102001`、business-use PaaS は `txcd_10102000` を
使い、customer type と所在地・tax ID を quote / invoice evidence に固定します。
適用税率は customer location と登録状況で変わります。

## Usage and Limits

共通の owner-account safety ceiling は total 250 Resources、Edge/Object/KV/Queue/
Schedule 各100、Database/Workflow/Stateful Actor 各50、Vector 25、Container 10、
active verified domains 25 です。これは plan feature ではありません。

## Spend Guard

operator hard cap は `$25 / single authorization`、`$100 / rolling day`、
`$500 / billing period` です。ユーザーは account / Workspace / service ごとに
これより低い budget を設定できます。上限の引き上げは support review が必要です。
Destroy / DELETE cleanup は、残高不足で既存 Resource を消せなくならないよう、
原則として追加 precharge なしで実行できます。

## Bring your own key

自分の Provider Connection で接続した外部 provider は Takosumi Cloud が
metering / spend-gate しません。請求と provider free tier はその provider との
契約に従います。Takosumi の usage event、invoice projection、catalog、status に
provider credential、API key、DSN、AI upstream key、payment secret は保存しません。
