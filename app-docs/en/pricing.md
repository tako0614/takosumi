# Takosumi Hosted pricing

The adopted launch prices for Takosumi Hosted and Takoserver are in
tax-exclusive USD. Both products use the monthly allowance and balance of the
same Organization.

> **Availability:** These are adopted launch prices. Shared login, Workspace
> and billing activation and staging verification are in progress. This page
> does not establish availability; check the authenticated price and service
> display. The Container price revision is also awaiting activation. New rates
> do not reprice past usage.

## Plans and top-ups

| Plan | Monthly price | Monthly usage allowance | Card |
| --- | ---: | ---: | --- |
| Free | `$0` | `$1.50` | Not required |
| `$10` plan | `$10` | `$20` | Required |
| `$50` plan | `$50` | `$100` | Required |

Allowances reset monthly. The Free `$1.50` does not stack with a paid plan.
Top-ups add their face value to the balance; the paid plan's doubled allowance
does not multiply a top-up. A payment method is required for paid plans,
top-ups and on-demand usage.

## Account, Workspace and balance

At launch, both products will use one account at `auth.takos.jp`. The first
login will create a personal Workspace. Additional team, billing and
environment Workspaces use the same Workspace and membership authority.
Matching email addresses alone never grant access to another Workspace.

Each Workspace's Organization binding selects the paying Organization.
Takosumi Hosted and Takoserver use one wallet for that Organization rather
than separate product balances. Usage records the source Workspace and
Resource and is shown with a per-Workspace breakdown. Switching between
Workspaces in the same Organization does not create another balance or
allowance.

## Usage prices

Cloudflare-backed usage is charged at **three times** the Cloudflare usage
rate in the versioned price revision supplied by Takoserver. A change to a
public supplier price does not make the browser recalculate a charge. Check
the authenticated price display for the applicable revision, meter, unit and
rate. A new revision applies to usage after activation.

[Takoserver shared hosted pricing](https://github.com/tako0614/takoserver/blob/main/config/shared-hosted-pricing.json)
owns the supplied price definitions. Takosumi Hosted displays the supplied
price and plan snapshots instead of creating another price authority or
commercial ledger. Supplier free tiers are separate from the Free allowance
above. An unpriced meter or unreleased service is not enabled by this page.

### Container launch rates

Containers will use the same rate across execution paths, based on Cloudflare
Containers costs. These adopted additional meters are awaiting publication
and activation of the price revision.

| Meter | Billing unit | Launch rate |
| --- | --- | ---: |
| CPU | vCPU-second | `$0.000060` |
| Memory | GiB-second | `$0.0000075` |
| Egress | GB | `$0.15` |
| Image storage | GB-month | `$0.045` |

CPU and memory use the overage rates in
[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
Egress uses one rate across regions, based on that page's highest regional
cost of `$0.05 / GB`. Image storage uses the
[R2 Standard storage rate](https://developers.cloudflare.com/r2/pricing/) of
`$0.015 / GB-month`. Disk is not an added meter in this revision. Usage of
Workers or other services serving a Container is charged by their applicable
enabled meters.

## Usage display and spending limits

The usage display shows the percentage of the allowance consumed and warns
at 80% and 95%. The default `onLimit` is `stop`, which stops consumption beyond
the allowance or balance. It does not automatically select a paid plan or
switch to postpaid billing.

| `onLimit` | Policy |
| --- | --- |
| `stop` | Default; stop affected consumption at the limit |
| `prepaid` | Use purchased balance only when explicitly selected |
| `postpaid` | Explicitly select postpaid billing after support and eligibility checks |
| `on-demand` | Explicitly select metered usage after checking payment method and terms |

Only choices enabled by the authenticated contract are shown. The current
supplier price definition marks `postpaid` as unsupported; it is not currently
an available choice. Reaching a limit does not automatically delete existing
Resources. Delete them through the provider graph that created them.

## Preview and invoice contract

Before execution, Preview shows the applicable price revision, meter, rate,
tax treatment, estimate and expiry. Apply uses the reviewed exact quote. An
unpriced meter, inactive catalog, missing manager, or expired quote stops
execution before the backend is called. Usage, reservations, refunds or
credits and invoice lines are reconciled before closing the billing period.

## Amount precision and tax

The shared ledger stores integer micro-USD (`$1 = 1,000,000 micro-USD`). For
example, Container memory costs `7,500 micro-USD` per `1,000 GiB-second`.
Fractional usage events are not each rounded up to a cent. The aggregated
billed amount is rounded up to cents once at payment time. Check Checkout and
the invoice for tax and the total payable amount.

## App addresses

Hosted apps will use `<name>.app.takos.jp` at launch. Names are unique across
both products, with one dispatch and wildcard TLS owned by Takoserver. This
is under staging verification; the production route switch has not happened.
Hosted custom domains are planned after launch. Self-hosted CustomDomain
choices remain available.

## Bring your own provider

An external provider connected through your own Provider Connection bills
you directly under its own contract. The Hosted allowance and three-times
rule are not applied again to that provider's charges. Self-hosted Takosumi
software has no usage fee. Pay the execution environment and external
provider costs to their respective suppliers.
