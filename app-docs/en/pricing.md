# Takosumi Cloud pricing

Takosumi Cloud combines a monthly subscription with metered usage. Prices are
tax-exclusive USD. Every plan can use the same managed-service catalog;
Resource counts are common safety ceilings, not plan features.

## Subscription plans

| Plan | Monthly price | Monthly managed-usage grant | Overage       |
| ---- | ------------: | --------------------------: | ------------- |
| Lite |          `$1` |                     `$0.50` | Metered usage |
| Plus |          `$5` |                     `$3.00` | Metered usage |
| Pro  |         `$10` |                     `$7.00` | Metered usage |

The grant is issued per billing period, cannot be redeemed for cash, and does
not roll over. External providers connected with your own Provider Connection
are billed directly by that provider and do not consume the grant.

## Usage prices

Takosumi Cloud's versioned PriceCatalog is the authority for managed-capacity
prices. Provider public prices remain cost-comparison inputs, but provider
invoices do not define tenant usage. Shared free tiers and fixed platform costs
are absorbed by the subscription rather than allocated as hidden per-tenant
free tiers. Catalog changes are versioned and effective-dated and never re-rate
old usage.

| Service                          | Billable item                         |                                                              Price |
| -------------------------------- | ------------------------------------- | -----------------------------------------------------------------: |
| Edge Worker                      | accepted gateway requests             |                                                  `$1.00 / million` |
| Edge Worker                      | active Ready Resource                 |                                           `$0.09 / Resource-month` |
| Edge Worker                      | CPU / subrequests                     |                 included (`10 CPU-ms`, `5` subrequests / dispatch) |
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

Object Storage delete, abort, and Internet egress, plus preview, binding,
secret configuration, route, schedule, static-asset control, observe, refresh,
and delete have explicit `$0` meters. Runtime or storage work they trigger is
still charged by the target service. Workflow state and step meters use a zero
catalog before `2026-08-10` and the rates above only on or after that date.

An Edge request is accepted after quota and credit reservation and successful
durable Takosumi usage capture. Tenant errors, CPU/subrequest limit failures,
and dispatch failures after that point remain one charged accepted request. A
failure before capture does not invoke tenant code and is not charged. Workers
Logs, invocation logs, and Logpush are disabled in Stable. Legacy `request`,
`cpu_time_us`, `subrequest`, `active_script_millisecond`, and log meters remain
explicit `$0` history rows and cannot authorize a new charge.

Provider cost references: [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[KV](https://developers.cloudflare.com/kv/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/),
[Workflows](https://developers.cloudflare.com/workflows/reference/pricing/),
[Containers](https://developers.cloudflare.com/containers/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), and
[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/).

## Preview and invoice contract

Preview returns the offering, SKU and PriceCatalog versions, tax treatment,
unit prices, estimate, and expiry. Apply accepts only that exact quote. An
unpriced meter, inactive catalog, missing manager, or expired quote fails
closed before backend execution.

Usage is aggregated in integer smallest units before billing-unit rounding;
Takosumi does not round every fractional event upward. A billing period does
not close until immutable usage, reservations, refunds or credits, and Stripe
invoice lines reconcile.

## Tax

Displayed prices exclude tax. Checkout and invoices use Stripe automatic tax.
Personal-use PaaS uses `txcd_10102001`; business-use PaaS uses
`txcd_10102000`. Customer type, location and tax-ID evidence are pinned to the
quote and invoice. The actual tax depends on customer location and our tax
registrations.

## Safety and spend limits

The owner-account safety ceiling is 250 total Resources; 100 each for Edge,
Object, KV, Queue and Schedule; 50 each for Database, Workflow and Stateful
Actor; 25 Vector indexes; 10 Containers; and 25 active verified domains. These
are not plan features.

Operator hard caps are `$25 / single authorization`, `$100 / rolling day`, and
`$500 / billing period`. Customers can set lower account, Workspace or service
budgets. Raising an operator cap requires support review. Destroy and DELETE
cleanup normally remain available without another precharge.

## Bring your own key

Takosumi Cloud does not meter or spend-gate an external provider connected with
your own Provider Connection. Billing and provider free tiers follow your
contract with that provider. Provider credentials, API keys, DSNs, AI upstream
keys, and payment secrets are never stored in usage events, invoice projections,
catalogs, or public status.
